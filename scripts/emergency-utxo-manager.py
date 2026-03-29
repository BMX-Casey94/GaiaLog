#!/usr/bin/env python3
"""
GaiaLog Emergency UTXO Manager (temporary DB-less mode).

This service provides:
  - GET /utxos/<address>       -> array of UTXOs (for BSV_UTXO_PROVIDER=custom)
  - POST /consume-admit        -> remove spent input and add change output
  - POST /admin/seed           -> seed/replace wallet UTXO state
  - GET /health                -> basic health summary

Intended usage:
  1) Run when Postgres/Supabase is unavailable.
  2) Enable GAIALOG_EMERGENCY_LEGACY_UTXO=true in GaiaLog.
  3) Point BSV_UTXO_ENDPOINT_TEMPLATE to this service.

Security:
  - Bind to localhost by default.
  - If GAIALOG_EMERGENCY_UTXO_MANAGER_SECRET is set, mutating endpoints require
    header: x-gaialog-utxo-manager-secret.
  - Optional allow-list via GAIALOG_EMERGENCY_UTXO_MANAGER_ALLOWED_ADDRESSES.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse


SAVE_INTERVAL_SECONDS = 10


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def parse_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def normalise_utxo(raw: dict[str, Any]) -> dict[str, Any] | None:
    txid = str(raw.get("txid") or raw.get("tx_hash") or raw.get("hash") or "").strip()
    vout = parse_int(raw.get("vout", raw.get("tx_pos", 0)), -1)
    satoshis = parse_int(raw.get("satoshis", raw.get("value", 0)), -1)
    if not txid or vout < 0 or satoshis < 0:
        return None

    confirmations = parse_int(raw.get("confirmations", 0), 0)
    height = parse_int(raw.get("height", 1 if confirmations > 0 else 0), 0)
    confirmed = bool(raw.get("confirmed")) if "confirmed" in raw else (confirmations > 0 or height > 0)

    return {
        "txid": txid,
        "vout": vout,
        "satoshis": satoshis,
        "confirmed": bool(confirmed),
        "confirmations": max(1, confirmations) if confirmed else 0,
        "height": max(1, height) if confirmed else 0,
        "script": str(
            raw.get("script")
            or raw.get("outputScript")
            or raw.get("lockingScript")
            or ""
        ).strip(),
    }


class UtxoStore:
    def __init__(self, state_path: Path, save_interval: float = SAVE_INTERVAL_SECONDS):
        self.state_path = state_path
        self.lock = threading.Lock()
        self.data: dict[str, Any] = {"wallets": {}, "updated_at": utc_now_iso()}
        self._dirty = False
        self._save_interval = save_interval
        self._shutdown = threading.Event()
        self._load()
        self._save_thread = threading.Thread(target=self._periodic_save, daemon=True)
        self._save_thread.start()

    def _load(self) -> None:
        with self.lock:
            if not self.state_path.exists():
                self.state_path.parent.mkdir(parents=True, exist_ok=True)
                self._flush_to_disk()
                return
            try:
                with open(self.state_path, "r", encoding="utf-8") as fh:
                    loaded = json.load(fh)
                wallets = loaded.get("wallets", {})
                if not isinstance(wallets, dict):
                    wallets = {}
                clean_wallets: dict[str, list[dict[str, Any]]] = {}
                for address, utxos in wallets.items():
                    if not isinstance(address, str) or not isinstance(utxos, list):
                        continue
                    normalised: list[dict[str, Any]] = []
                    for raw in utxos:
                        if isinstance(raw, dict):
                            n = normalise_utxo(raw)
                            if n:
                                normalised.append(n)
                    clean_wallets[address] = normalised
                self.data = {
                    "wallets": clean_wallets,
                    "updated_at": loaded.get("updated_at", utc_now_iso()),
                }
                total = sum(len(v) for v in clean_wallets.values())
                print(f"[utxo-manager] loaded {total} UTXOs across {len(clean_wallets)} wallets")
            except Exception as exc:
                print(f"[utxo-manager] failed to load state, starting empty: {exc}", file=sys.stderr)
                self.data = {"wallets": {}, "updated_at": utc_now_iso()}
                self._flush_to_disk()

    def _mark_dirty(self) -> None:
        self._dirty = True

    def _flush_to_disk(self) -> None:
        """Write state to disk. Must be called with self.lock held."""
        self.data["updated_at"] = utc_now_iso()
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self.data, fh, separators=(",", ":"))
            tmp.replace(self.state_path)
            self._dirty = False
        except Exception as exc:
            print(f"[utxo-manager] save failed: {exc}", file=sys.stderr)
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass

    def _periodic_save(self) -> None:
        while not self._shutdown.is_set():
            self._shutdown.wait(self._save_interval)
            if self._dirty:
                with self.lock:
                    if self._dirty:
                        self._flush_to_disk()

    def shutdown(self) -> None:
        self._shutdown.set()
        with self.lock:
            if self._dirty:
                self._flush_to_disk()
        print("[utxo-manager] final save complete")

    def list_for_address(self, address: str, confirmed_only: bool, min_satoshis: int) -> list[dict[str, Any]]:
        with self.lock:
            wallet_utxos = self.data.get("wallets", {}).get(address)
            if wallet_utxos is None:
                return []
            snapshot = wallet_utxos[:]

        filtered = []
        for utxo in snapshot:
            if confirmed_only and not utxo.get("confirmed"):
                continue
            sats = utxo.get("satoshis", 0)
            if sats < min_satoshis:
                continue
            filtered.append(
                {
                    "tx_hash": utxo["txid"],
                    "tx_pos": utxo["vout"],
                    "value": sats,
                    "confirmations": utxo.get("confirmations", 0),
                    "height": utxo.get("height", 0),
                    "script": utxo.get("script", ""),
                }
            )
        return filtered

    def consume_admit(self, payload: dict[str, Any]) -> dict[str, Any]:
        address = str(payload.get("address", "")).strip()
        spent_txid = str(payload.get("spentTxid", "")).strip()
        spent_vout = parse_int(payload.get("spentVout", -1), -1)
        spending_txid = str(payload.get("spendingTxid", "")).strip()
        change = payload.get("change")

        if not address or not spent_txid or spent_vout < 0 or not spending_txid:
            raise ValueError("address, spentTxid, spentVout, and spendingTxid are required")

        with self.lock:
            wallets = self.data.setdefault("wallets", {})
            current = wallets.get(address, [])
            before = len(current)
            current = [
                item
                for item in current
                if not (item.get("txid") == spent_txid and item.get("vout") == spent_vout)
            ]
            removed = before - len(current)

            added = 0
            if isinstance(change, dict):
                satoshis = parse_int(change.get("satoshis", 0), 0)
                vout = parse_int(change.get("vout", -1), -1)
                if satoshis > 0 and vout >= 0:
                    normalised = normalise_utxo({
                        "txid": spending_txid,
                        "vout": vout,
                        "satoshis": satoshis,
                        "confirmed": bool(change.get("confirmed", False)),
                        "script": str(change.get("outputScript", "")).strip(),
                    })
                    if normalised:
                        current.append(normalised)
                        added = 1

            wallets[address] = current
            self._mark_dirty()
            return {"removed": removed, "added": added, "remaining": len(current)}

    def seed(self, payload: dict[str, Any]) -> dict[str, Any]:
        replace = bool(payload.get("replace", True))
        seeded_wallets = 0
        seeded_utxos = 0

        with self.lock:
            wallets = self.data.setdefault("wallets", {})

            if isinstance(payload.get("wallets"), dict):
                if replace:
                    wallets.clear()
                for address, utxos in payload["wallets"].items():
                    if not isinstance(address, str) or not isinstance(utxos, list):
                        continue
                    normalised = []
                    for raw in utxos:
                        if isinstance(raw, dict):
                            n = normalise_utxo(raw)
                            if n:
                                normalised.append(n)
                    wallets[address] = normalised
                    seeded_wallets += 1
                    seeded_utxos += len(normalised)
            else:
                address = str(payload.get("address", "")).strip()
                utxos = payload.get("utxos", [])
                if not address or not isinstance(utxos, list):
                    raise ValueError("seed requires either wallets{} or address + utxos[]")
                normalised = []
                for raw in utxos:
                    if isinstance(raw, dict):
                        n = normalise_utxo(raw)
                        if n:
                            normalised.append(n)
                if replace:
                    wallets[address] = normalised
                else:
                    wallets[address] = wallets.get(address, []) + normalised
                seeded_wallets = 1
                seeded_utxos = len(normalised)

            self._mark_dirty()

        return {"wallets": seeded_wallets, "utxos": seeded_utxos}

    def stats(self) -> dict[str, Any]:
        with self.lock:
            wallets = self.data.get("wallets", {})
            return {
                "wallets": len(wallets),
                "utxos": sum(len(items) for items in wallets.values()),
                "updatedAt": self.data.get("updated_at"),
                "dirty": self._dirty,
            }


class Handler(BaseHTTPRequestHandler):
    store: UtxoStore
    secret: str
    allowed_addresses: set[str]

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[utxo-manager] {self.address_string()} - {fmt % args}")

    def _safe_write(self, status: int, payload: Any) -> None:
        try:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _read_json(self) -> dict[str, Any]:
        length = parse_int(self.headers.get("content-length"), 0)
        raw = self.rfile.read(max(0, length))
        if not raw:
            return {}
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object")
        return data

    def _authorised(self) -> bool:
        if not self.secret:
            return True
        provided = self.headers.get("x-gaialog-utxo-manager-secret", "")
        return provided == self.secret

    def _address_allowed(self, address: str) -> bool:
        if not self.allowed_addresses:
            return True
        return address in self.allowed_addresses

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "/health":
            self._safe_write(200, {"ok": True, **self.store.stats()})
            return

        if path.startswith("/utxos/"):
            address = unquote(path.split("/utxos/", 1)[1]).strip()
            if not address:
                self._safe_write(400, {"ok": False, "error": "address is required"})
                return
            if not self._address_allowed(address):
                self._safe_write(403, {"ok": False, "error": "address is not allow-listed"})
                return

            q = parse_qs(parsed.query)
            confirmed_only = parse_bool((q.get("confirmedOnly") or [None])[0], False)
            min_sats = parse_int((q.get("minSatoshis") or [0])[0], 0)
            utxos = self.store.list_for_address(address, confirmed_only, max(0, min_sats))
            self._safe_write(200, utxos)
            return

        self._safe_write(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        try:
            if path == "/consume-admit":
                if not self._authorised():
                    self._safe_write(401, {"ok": False, "error": "unauthorised"})
                    return
                payload = self._read_json()
                address = str(payload.get("address", "")).strip()
                if not self._address_allowed(address):
                    self._safe_write(403, {"ok": False, "error": "address is not allow-listed"})
                    return
                result = self.store.consume_admit(payload)
                self._safe_write(200, {"ok": True, **result})
                return

            if path == "/admin/seed":
                if not self._authorised():
                    self._safe_write(401, {"ok": False, "error": "unauthorised"})
                    return
                payload = self._read_json()
                result = self.store.seed(payload)
                self._safe_write(200, {"ok": True, **result})
                return

            self._safe_write(404, {"ok": False, "error": "not found"})
        except ValueError as err:
            self._safe_write(400, {"ok": False, "error": str(err)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as err:
            self._safe_write(500, {"ok": False, "error": str(err)})


def main() -> None:
    host = os.environ.get("GAIALOG_EMERGENCY_UTXO_MANAGER_HOST", "127.0.0.1")
    port = parse_int(os.environ.get("GAIALOG_EMERGENCY_UTXO_MANAGER_PORT", "8787"), 8787)
    state_path = Path(
        os.environ.get(
            "GAIALOG_EMERGENCY_UTXO_MANAGER_STATE",
            str(Path.cwd() / "data" / "emergency-utxo-manager-state.json"),
        )
    )
    secret = os.environ.get("GAIALOG_EMERGENCY_UTXO_MANAGER_SECRET", "").strip()
    allowed = {
        item.strip()
        for item in os.environ.get("GAIALOG_EMERGENCY_UTXO_MANAGER_ALLOWED_ADDRESSES", "").split(",")
        if item.strip()
    }

    store = UtxoStore(state_path=state_path)
    Handler.store = store
    Handler.secret = secret
    Handler.allowed_addresses = allowed

    server = ThreadingHTTPServer((host, port), Handler)
    print(
        f"[utxo-manager] listening on http://{host}:{port} "
        f"(state={state_path}, allowList={len(allowed)}, saveInterval={SAVE_INTERVAL_SECONDS}s)"
    )

    def shutdown_handler(*_: Any) -> None:
        print("[utxo-manager] shutting down...")
        store.shutdown()
        server.shutdown()

    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)
    server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
