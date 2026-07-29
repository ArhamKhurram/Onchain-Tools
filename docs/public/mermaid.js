// Client-side Mermaid rendering for ```mermaid fences.
//
// The build leaves mermaid fences as <pre><code class="language-mermaid">
// (Shiki excludes the language; Expressive Code is disabled). This script
// swaps each one for a rendered SVG and re-renders when the Starlight theme
// toggle flips data-theme on <html>.
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

const sources = [];

function collect() {
  for (const code of document.querySelectorAll('code.language-mermaid')) {
    const pre = code.closest('pre') ?? code;
    const holder = document.createElement('div');
    holder.className = 'mermaid-holder';
    pre.replaceWith(holder);
    sources.push({ holder, text: code.textContent ?? '' });
  }
}

let renderSeq = 0;

async function renderAll() {
  const seq = ++renderSeq;
  const dark = document.documentElement.dataset.theme !== 'light';
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'neutral',
    themeVariables: { fontSize: '14px' },
  });
  for (let i = 0; i < sources.length; i++) {
    const { holder, text } = sources[i];
    try {
      const { svg } = await mermaid.render(`oct-mmd-${seq}-${i}`, text);
      if (seq !== renderSeq) return; // superseded by a newer theme toggle
      const div = document.createElement('div');
      div.className = 'mermaid';
      div.innerHTML = svg;
      holder.replaceChildren(div);
    } catch (err) {
      console.error('[docs] mermaid render failed:', err);
      const fallback = document.createElement('pre');
      fallback.textContent = text;
      holder.replaceChildren(fallback);
    }
  }
}

collect();
renderAll();

new MutationObserver(() => renderAll()).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme'],
});
