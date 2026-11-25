/**
 * Reversible slug encoding for location pages.
 *
 * `overlay_explorer_location_keys.normalized_location` is the identity of a
 * location (it is that table's primary key). Real values include spaces,
 * commas and mixed case, e.g. `kent, south london and east sussex` and
 * `lonf1`. A slug must therefore be:
 *
 *   1. Reversible, so the same slug always resolves to exactly one location.
 *   2. Collision-free. A lossy transform cannot distinguish a literal hyphen
 *      from a space, so `wilkes-barre` and `wilkes barre` would share a URL and
 *      one would shadow the other.
 *   3. Path-safe. No `/`, and no character a router or proxy might decode,
 *      split or reject.
 *
 * Scheme:
 *
 *   `a`–`z`, `0`–`9`   emitted as-is
 *   space              → `-`
 *   anything else      → `~` + exactly 4 lowercase hex digits
 *
 * The hex escape is fixed-width. An earlier draft used a variable-width run of
 * hex digits, which broke on `a/b` (`~2fb`): the decoder read `2fb` as a single
 * code point and `b` was swallowed. Fixed width removes that ambiguity
 * entirely.
 *
 * A literal hyphen is escaped (`~2d`) rather than doubled, so `-` in a slug
 * always means a space and `a  b` and `a-b` encode differently.
 *
 * Encoding iterates UTF-16 code units rather than code points so every escaped
 * unit is exactly 4 hex digits. A character outside the Basic Multilingual
 * Plane becomes two escapes, which decode back into the same string.
 *
 * `~` is unreserved in RFC 3986, so it needs no further escaping in a path.
 */

/** Escape sequence introducer. */
const ESCAPE = "~"

/** Escape a single UTF-16 code unit as `~` + 4 hex digits. */
function escapeUnit(code: number): string {
  return `${ESCAPE}${code.toString(16).padStart(4, "0")}`
}

/** Encode a normalised location into a URL path segment. */
export function locationToSlug(normalized: string): string {
  let out = ""
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]
    if (char === " ") {
      out += "-"
    } else if (char >= "a" && char <= "z") {
      out += char
    } else if (char >= "0" && char <= "9") {
      out += char
    } else {
      out += escapeUnit(normalized.charCodeAt(i))
    }
  }
  return out
}

/**
 * Decode a slug back to the normalised location, or `null` if it is malformed.
 *
 * Returns `null` rather than a best guess so a bad URL becomes a 404 instead of
 * silently rendering a different location's page under the wrong canonical.
 */
export function slugToLocation(slug: string): string | null {
  let out = ""
  for (let i = 0; i < slug.length; i++) {
    const char = slug[i]
    if (char === ESCAPE) {
      const hex = slug.slice(i + 1, i + 5)
      // A truncated or non-hex escape is a malformed slug, not a location.
      if (hex.length !== 4 || !/^[0-9a-f]{4}$/.test(hex)) return null
      out += String.fromCharCode(parseInt(hex, 16))
      i += 4
    } else if (char === "-") {
      out += " "
    } else if ((char >= "a" && char <= "z") || (char >= "0" && char <= "9")) {
      out += char
    } else {
      // Any other raw character means this was not produced by the encoder.
      return null
    }
  }
  return out.length > 0 ? out : null
}

/** Round-trip check used by tests and by the route handler before querying. */
export function slugRoundTrips(normalized: string): boolean {
  return slugToLocation(locationToSlug(normalized)) === normalized
}
