import ts from "typescript";

export const kindAtStart = (source: string): ts.SyntaxKind => {
  const file = ts.createSourceFile("input.ts", source, ts.ScriptTarget.Latest);
  return file.statements[0]?.kind ?? ts.SyntaxKind.EndOfFileToken;
};

if (import.meta.main && kindAtStart("export const value = 1;") !== ts.SyntaxKind.VariableStatement) {
  process.exitCode = 1;
}
