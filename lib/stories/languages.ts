// The languages a code block can be tagged with. Plain data, shared by the editor, the schema and the reader.

export const CODE_LANGUAGES = [
  { id: "js", label: "JavaScript", grammar: "javascript" },
  { id: "ts", label: "TypeScript", grammar: "typescript" },
  { id: "python", label: "Python", grammar: "python" },
  { id: "sql", label: "SQL", grammar: "sql" },
  { id: "bash", label: "Bash", grammar: "bash" },
  { id: "json", label: "JSON", grammar: "json" },
  { id: "cpp", label: "C/C++", grammar: "cpp" },
  { id: "java", label: "Java", grammar: "java" },
  { id: "html", label: "HTML", grammar: "xml" },
  { id: "css", label: "CSS", grammar: "css" },
  { id: "yaml", label: "YAML", grammar: "yaml" },
  { id: "plain", label: "Plain text", grammar: "plaintext" },
] as const;

export type CodeLanguage = (typeof CODE_LANGUAGES)[number]["id"];

export const CODE_LANGUAGE_IDS = CODE_LANGUAGES.map((l) => l.id) as [CodeLanguage, ...CodeLanguage[]];

export function languageLabel(id: string): string {
  return CODE_LANGUAGES.find((l) => l.id === id)?.label ?? "Plain text";
}
