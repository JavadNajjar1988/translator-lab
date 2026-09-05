function cleanName(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
}

function elementKey(entry) {
  return `${String(entry?.osmType || "").toUpperCase()}:${String(entry?.osmId || "")}`;
}

function wikidataId(entry) {
  const match = /^(Q\d+)$/i.exec(String(entry?.wikidataId || "").trim());
  return match ? match[1].toUpperCase() : "";
}

export function mergeIdentitySnapshotHistory(entries, previousSnapshot) {
  const previousByElement = new Map((previousSnapshot?.entries || []).map((entry) => [elementKey(entry), entry]));
  return entries.map((entry) => {
    const previous = previousByElement.get(elementKey(entry));
    const currentId = wikidataId(entry);
    const previousId = wikidataId(previous);
    if (!previous || !currentId || currentId !== previousId) return entry;
    const currentName = cleanName(entry.name).toLocaleLowerCase("und");
    const previousNames = [...new Set([previous.name, ...(previous.previousNames || [])]
      .map(cleanName).filter((name) => name && name.toLocaleLowerCase("und") !== currentName))];
    return previousNames.length ? { ...entry, previousNames } : entry;
  });
}
