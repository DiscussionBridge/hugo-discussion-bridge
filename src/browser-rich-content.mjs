import mermaid from "mermaid";
import katex from "katex";
import mathStyles from "katex/dist/katex.min.css";

const selector = "pre > code.lang-mermaid, pre > code.language-mermaid";

async function render(root = document) {
  for (const element of root.querySelectorAll(".math")) {
    if (!element.querySelector(".katex") && element.textContent.trim()) katex.render(element.textContent.trim(), element, { displayMode: element.tagName === "DIV", throwOnError: false, strict: "warn", trust: false });
  }
  for (const paragraph of root.querySelectorAll("p")) {
    const match = /^\s*(?:\[math\]([\s\S]*?)\[\/math\]|\$\$([\s\S]*?)\$\$)\s*$/u.exec(paragraph.textContent);
    if (match) { paragraph.replaceChildren(); katex.render((match[1] ?? match[2]).trim(), paragraph, { displayMode: true, throwOnError: false, strict: "warn", trust: false }); }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
  while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest("code, pre, script, style, .katex, .math")) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const source = node.textContent, pattern = /\[math\]([\s\S]*?)\[\/math\]|\$([^$\n]+?)\$/gu;
    if (!pattern.test(source)) continue;
    pattern.lastIndex = 0; const fragment = document.createDocumentFragment(); let offset = 0;
    for (const match of source.matchAll(pattern)) { fragment.append(source.slice(offset, match.index)); const span = document.createElement("span"); katex.render((match[1] ?? match[2]).trim(), span, { throwOnError: false, strict: "warn", trust: false }); fragment.append(span); offset = match.index + match[0].length; }
    fragment.append(source.slice(offset)); node.replaceWith(fragment);
  }
  const diagrams = [...root.querySelectorAll(selector)].map((code) => {
    const container = document.createElement("div");
    container.className = "mermaid discussionbridge-mermaid";
    container.textContent = code.textContent ?? "";
    code.parentElement.replaceWith(container);
    return container;
  });
  if (!diagrams.length) return;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  await mermaid.run({ nodes: diagrams, suppressErrors: false });
}

const style = document.createElement("style");
style.textContent = `${mathStyles}\n.discussionbridge-mermaid{max-width:100%;overflow-x:auto}.discussionbridge-mermaid svg{display:block;height:auto;max-width:100%;margin-inline:auto}.katex-display{overflow-x:auto;overflow-y:hidden}`;
document.head.append(style);

const start = () => render(document).catch(() => {});
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();

export { render };
