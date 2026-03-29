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
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse


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
    def __init__(self, state_path: Path):
        self.state_path = state_path
        self.lock = threading.RLock()
        self.data: dict[str, Any] = {"wallets": {}, "updated_at": utc_now_iso()}
        self._load()

    def _load(self) -> None:
        with self.lock:
            if not self.state_path.exists():
                self.state_path.parent.mkdir(parents=True, exist_ok=True)
                self._save_unlocked()
                return
            try:
                loaded = json.loads(self.state_path.read_text(encoding="utf-8"))
                wallets = loaded.get("wallets", {})
                if not isinstance(wallets, dict):
                    wallets = {}
                clean_wallets: dict[str, list[dict[str, Any]]] = {}
                for address, utxos in wallets.items():
                    if not isinstance(address, str):
                        continue
                    if not isinstance(utxos, list):
                        continue
                    normalised: list[dict[str, Any]] = []
                    for raw in utxos:
                        if not isinstance(raw, dict):
                            continue
                        n = normalise_utxo(raw)
                        if n:
                            normalised.append(n)
                    clean_wallets[address] = normalised
                self.data = {
                    "wallets": clean_wallets,
                    "updated_at": loaded.get("updated_at", utc_now_iso()),
                }
            except Exception:
                # If state is corrupt, keep service alive with empty state.
                self.data = {"wallets": {}, "updated_at": utc_now_iso()}
                self._save_unlocked()

    def _save_unlocked(self) -> None:
        self.data["updated_at"] = utc_now_iso()
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
        tmp.write_text(json.dumps(self.data, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(self.state_path)

    def list_for_address(self, address: str, confirmed_only: bool, min_satoshis: int) -> list[dict[str, Any]]:
        with self.lock:
            utxos = list(self.data.get("wallets", {}).get(address, []))
        filtered = []
        for utxo in utxos:
            if confirmed_only and not bool(utxo.get("confirmed")):
                continue
            if parse_int(utxo.get("satoshis", 0), 0) < min_satoshis:
                continue
            filtered.append(
                {
                    "tx_hash": utxo["txid"],
                    "tx_pos": int(utxo["vout"]),
                    "value": int(utxo["satoshis"]),
                    "confirmations": int(utxo.get("confirmations", 0)),
                    "height": int(utxo.get("height", 0)),
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
            current = list(wallets.get(address, []))
            before = len(current)
            current = [
                item
                for item in current
                if not (item.get("txid") == spent_txid and int(item.get("vout", -1)) == spent_vout)
            ]
            removed = before - len(current)

            added = 0
            if isinstance(change, dict):
                satoshis = parse_int(change.get("satoshis", 0), 0)
                vout = parse_int(change.get("vout", -1), -1)
                if satoshis > 0 and vout >= 0:
                    raw = {
                        "txid": spending_txid,
                        "vout": vout,
                        "satoshis": satoshis,
                        "confirmed": bool(change.get("confirmed", False)),
                        "script": str(change.get("outputScript", "")).strip(),
                    }
                    normalised = normalise_utxo(raw)
                    if normalised:
                        current.append(normalised)
                        added = 1

            wallets[address] = current
            self._save_unlocked()
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
                    wallets[address] = list(wallets.get(address, [])) + normalised
                seeded_wallets = 1
                seeded_utxos = len(normalised)

            self._save_unlocked()

        return {"wallets": seeded_wallets, "utxos": seeded_utxos}

    def stats(self) -> dict[str, Any]:
        with self.lock:
            wallets = self.data.get("wallets", {})
            return {
                "wallets": len(wallets),
                "utxos": sum(len(items) for items in wallets.values()),
                "updatedAt": self.data.get("updated_at"),
            }


class Handler(BaseHTTPRequestHandler):
    store: UtxoStore
    secret: str
    allowed_addresses: set[str]

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep logs concise for pm2.
        print(f"[utxo-manager] {self.address_string()} - {fmt % args}")

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
            self._json(200, {"ok": True, **self.store.stats()})
            return

        if path.startswith("/utxos/"):
            address = unquote(path.split("/utxos/", 1)[1]).strip()
            if not address:
                self._json(400, {"ok": False, "error": "address is required"})
                return
            if not self._address_allowed(address):
                self._json(403, {"ok": False, "error": "address is not allow-listed"})
                return

            q = parse_qs(parsed.query)
            confirmed_only = parse_bool((q.get("confirmedOnly") or [None])[0], False)
            min_sats = parse_int((q.get("minSatoshis") or [0])[0], 0)
            utxos = self.store.list_for_address(address, confirmed_only, max(0, min_sats))
            # Return plain list because GaiaLog custom UTXO provider expects an array.
            self._json(200, utxos)
            return

        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        try:
            if path == "/consume-admit":
                if not self._authorised():
                    self._json(401, {"ok": False, "error": "unauthorised"})
                    return
                payload = self._read_json()
                address = str(payload.get("address", "")).strip()
                if not self._address_allowed(address):
                    self._json(403, {"ok": False, "error": "address is not allow-listed"})
                    return
                result = self.store.consume_admit(payload)
                self._json(200, {"ok": True, **result})
                return

            if path == "/admin/seed":
                if not self._authorised():
                    self._json(401, {"ok": False, "error": "unauthorised"})
                    return
                payload = self._read_json()
                result = self.store.seed(payload)
                self._json(200, {"ok": True, **result})
                return

            self._json(404, {"ok": False, "error": "not found"})
        except ValueError as err:
            self._json(400, {"ok": False, "error": str(err)})
        except Exception as err:
            self._json(500, {"ok": False, "error": str(err)})


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
        f"(state={state_path}, allowList={len(allowed)})"
    )

    def shutdown(*_: Any) -> None:
        print("[utxo-manager] shutting down...")
        server.shutdown()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()

