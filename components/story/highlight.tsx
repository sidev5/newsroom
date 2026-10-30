import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { ReactNode } from "react";
import { CODE_LANGUAGES, type CodeLanguage } from "@/lib/stories/languages";

// Syntax highlighting for code blocks. This file is only ever imported with import() from CodeBlock, after a code block has
// appeared on screen, so the library and its eleven grammars are a separate chunk that the homepage never loads.
//
// It uses lowlight, which returns a tree (not an HTML string), and the tree is turned into React elements below: only <span>
// elements with highlight.js class names and text are produced. Nothing is ever put into the page as HTML, the code stays
// text, and the colours come from classes in globals.css (no style attributes), so the policy needs nothing extra.

const lowlight = createLowlight({ bash, cpp, css, java, javascript, json, python, sql, typescript, xml, yaml });

type HastText = { type: "text"; value: string };
type HastElement = { type: "element"; tagName: string; properties?: { className?: unknown }; children: HastNode[] };
type HastNode = HastText | HastElement | { type: string };

const CLASS = /^hljs-[a-z_-]+$/;

function render(nodes: HastNode[], prefix = "n"): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${prefix}${i}`;
    if (node.type === "text") return (node as HastText).value;
    if (node.type !== "element") return null;
    const el = node as HastElement;
    const classes = Array.isArray(el.properties?.className) ? (el.properties!.className as unknown[]).filter((c): c is string => typeof c === "string" && CLASS.test(c)) : [];
    return (
      <span key={key} className={classes.join(" ") || undefined}>
        {render(el.children ?? [], `${key}-`)}
      </span>
    );
  });
}

/** The highlighted tree, or a single text node when the grammar fails on this input. */
function tree(grammar: string, code: string): HastNode[] {
  try {
    return lowlight.highlight(grammar, code).children as HastNode[];
  } catch {
    return [{ type: "text", value: code }];
  }
}

/** The code as highlighted text. A language that has no grammar (plain text) is returned as it is. */
export function HighlightedCode({ code, language }: { code: string; language: CodeLanguage }) {
  const grammar = CODE_LANGUAGES.find((l) => l.id === language)?.grammar;
  if (!grammar || grammar === "plaintext" || !lowlight.registered(grammar)) return <>{code}</>;
  return <>{render(tree(grammar, code))}</>;
}
