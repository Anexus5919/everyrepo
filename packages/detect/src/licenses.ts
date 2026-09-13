const LICENSE_FILE = /^(licen[cs]e|copying)([.-][\w.-]+)?$/i;

export function isLicenseFile(fileName: string): boolean {
  return LICENSE_FILE.test(fileName);
}

// Accepts npm, Cargo and pyproject shapes; "SEE LICENSE IN" means the file must be read instead
export function normalizeLicenseField(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return !trimmed || /see licen[cs]e in/i.test(trimmed) ? undefined : trimmed;
  }
  if (Array.isArray(value)) {
    const names = value.map(normalizeLicenseField).filter((name): name is string => !!name);
    return names.length > 0 ? names.join(" OR ") : undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return normalizeLicenseField(record["type"] ?? record["text"] ?? record["name"]);
  }
  return undefined;
}

export function classifyLicenseText(text: string): string {
  const head = text.slice(0, 4000);
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(head)) return "AGPL-3.0";
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(head)) return "LGPL";
  if (/GNU GENERAL PUBLIC LICENSE/i.test(head)) {
    return /Version 2/i.test(head) ? "GPL-2.0" : "GPL-3.0";
  }
  if (/Apache License/i.test(head) && /Version 2\.0/i.test(head)) return "Apache-2.0";
  if (/Mozilla Public License/i.test(head)) return "MPL-2.0";
  if (/Permission is hereby granted, free of charge/i.test(head)) return "MIT";
  if (/Redistribution and use in source and binary forms/i.test(head)) return "BSD";
  if (/ISC License/i.test(head)) return "ISC";
  if (/commercial|end user license agreement|all rights reserved/i.test(head)) return "commercial";
  return "unknown";
}
