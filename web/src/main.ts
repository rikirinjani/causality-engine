/**
 * Site entry point.
 *
 * Two jobs: mount the demo, and reveal sections on scroll when the visitor has
 * not asked for reduced motion. Everything else is static HTML.
 */
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";

import { mountDemo } from "./components/demo.js";

function initDemo(): void {
  const root = document.querySelector<HTMLElement>("[data-demo]");
  if (root === null) return;
  mountDemo(root);
}

function initReveal(): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const targets = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));

  // Without motion, or without IntersectionObserver, show everything at once.
  if (reduced || typeof IntersectionObserver === "undefined") {
    for (const el of targets) el.classList.add("is-visible");
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.06 },
  );

  for (const el of targets) observer.observe(el);
}

function initYear(): void {
  const slot = document.querySelector("[data-year]");
  if (slot !== null) slot.textContent = String(new Date().getFullYear());
}

function boot(): void {
  initDemo();
  initReveal();
  initYear();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
