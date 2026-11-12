import ts from "typescript";
import { sha256 } from "./check";
import type { BaselineEntry } from "./model";

export type SurfaceKind = "tool" | "cli-command" | "tui-alias" | "cli-usage" | "cli-flag" | "tui-command" | "record-kind" | "config-field" | "config-key" | "provider-option" | "keyboard";
export interface SurfaceEntry extends BaselineEntry {
  kind: SurfaceKind;
  name: string;
  line: number;
  detail: string;
}

function literal(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}
function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const p = object.properties.find((p) => p.name && (ts.isIdentifier(p.name) ? p.name.text : literal(p.name)) === name);
  return p && ts.isPropertyAssignment(p) ? p.initializer : undefined;
}
function namedOwner(node: ts.Node): string {
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if ((ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) && parent.name) return parent.name.getText();
    parent = parent.parent;
  }
  return "inline";
}

/** Candidate enumeration only: additions stay unclassified until reviewed.
 * Broad record/config candidates deliberately include internal discriminants;
 * the reviewed catalogue must explain them rather than silently ignore them.
 */
export function scanSurfaces(source: string, text: string): SurfaceEntry[] {
  const tree = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true, source.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const entries = new Map<string, SurfaceEntry>();
  const sourceHash = sha256(text);
  const add = (kind: SurfaceKind, name: string, node: ts.Node, detail = node.getText(tree)) => {
    const id = `${kind}:${source}:${name}`;
    if (!entries.has(id)) entries.set(id, { id, kind, name, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, detail, source, sourceHash, capabilityIds: [], nonCapabilityReason: null });
  };
  function visit(node: ts.Node) {
    if (ts.isObjectLiteralExpression(node)) {
      const name = literal(property(node, "name"));
      if (name && property(node, "parameters") && property(node, "description")) add("tool", name, node);
      const usage = literal(property(node, "usage"));
      if (name && (usage?.startsWith("/") || property(node, "busyBehavior"))) {
        add("tui-command", name, node, usage ?? `/${name}`);
        const aliases = property(node, "aliases");
        if (aliases && ts.isArrayLiteralExpression(aliases)) for (const alias of aliases.elements) {
          const text = literal(alias); if (text) add("tui-alias", text, alias, `alias of /${name}`);
        }
      }
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "kind") {
      const kind = literal(node.initializer);
      if (kind) add("record-kind", kind, node);
    }
    if (ts.isPropertySignature(node) && /^(src\/config\/|src\/mcp\/config-entry\.ts)/.test(source)) {
      add("config-field", `${namedOwner(node)}.${node.name.getText(tree)}`, node);
    }
    if (ts.isTypeAliasDeclaration(node) && ["VesicleProvider", "ResponsesProfile", "ResponsesTransport", "ProviderAuthMethod"].includes(node.name.text)) {
      const optionName = node.name.text;
      function choices(n: ts.Node) { const value = literal(n); if (value) add("provider-option", `${optionName}:${value}`, n); ts.forEachChild(n, choices); }
      choices(node.type);
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
      const right = literal(node.right), left = node.left.getText(tree);
      if (right !== undefined) {
        if (/^(src\/config\/|src\/mcp\/config)/.test(source) && /^(key|field|section)$/.test(left)) add("config-key", right, node);
        if (/\.kind$/.test(left)) add("record-kind", right, node);
        if (/^src\/(tui|setup)\//.test(source) && /(?:key|event)\??\.name$/.test(left)) add("keyboard", right, node);
      }
    }
    const value = literal(node);
    if (value && /kind/i.test(namedOwner(node))) add("record-kind", value, node);
    if (value && namedOwner(node) === "KNOWN_COMMANDS") add("cli-command", value, node);
    if (value && /^src\/cli\//.test(source)) {
      if (/^--?[a-z][a-z0-9-]*$/i.test(value)) add("cli-flag", value, node);
      const usage = value.trim().replace(/^Usage:\s*/i, "");
      if (/^vesicle(?:\s|$)/.test(usage)) add("cli-usage", usage, node, usage);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
}
