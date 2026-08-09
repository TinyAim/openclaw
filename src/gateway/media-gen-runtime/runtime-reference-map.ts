export type RuntimeReferenceMap = Map<
  string,
  { providerRef: string; mimeType: string; sha256: string }
>;

export function parseRuntimeReferenceMap(raw: string | undefined): RuntimeReferenceMap | null {
  if (!raw?.trim()) {
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const result: RuntimeReferenceMap = new Map();
  for (const [handle, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!handle.trim() || !value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).some((key) => !["providerRef", "mimeType", "sha256"].includes(key)) ||
      typeof row.providerRef !== "string" ||
      !(
        /^asset:\/\/[a-zA-Z0-9._:/-]+$/u.test(row.providerRef) ||
        row.providerRef.startsWith("https://")
      ) ||
      typeof row.mimeType !== "string" ||
      row.mimeType.trim().length === 0 ||
      typeof row.sha256 !== "string"
    ) {
      return null;
    }
    const sha = row.sha256.startsWith("sha256:") ? row.sha256.slice(7) : row.sha256;
    if (!/^[a-f0-9]{64}$/u.test(sha)) {
      return null;
    }
    result.set(handle, {
      providerRef: row.providerRef,
      mimeType: row.mimeType.trim().toLowerCase(),
      sha256: sha,
    });
  }
  return result;
}

/** Luma can fetch only an owner-hosted HTTPS image, never asset:// or bytes. */
export function hasLumaI2vReference(references: RuntimeReferenceMap): boolean {
  for (const reference of references.values()) {
    if (!reference.mimeType.startsWith("image/")) {
      continue;
    }
    try {
      const url = new URL(reference.providerRef);
      if (url.protocol === "https:" && !url.username && !url.password && url.hostname) {
        return true;
      }
    } catch {
      // The generic parser permits future provider reference shapes; this
      // exact route remains unavailable for an unreadable URL.
    }
  }
  return false;
}
