const SENSITIVE_EXACT_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  "credentials.json",
]);

const SENSITIVE_DIRECTORIES = new Set([
  ".ssh",
  ".aws",
  ".azure",
  ".gcp",
]);

const SENSITIVE_EXTENSIONS = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
];

export function isSensitiveRepositoryPath(path: string): boolean {
  return path.split("/").some((segment) => {
    const name = segment.toLowerCase();
    return name === ".env"
      || name.startsWith(".env.")
      || SENSITIVE_EXACT_NAMES.has(name)
      || SENSITIVE_DIRECTORIES.has(name)
      || SENSITIVE_EXTENSIONS.some((extension) => name.endsWith(extension));
  });
}
