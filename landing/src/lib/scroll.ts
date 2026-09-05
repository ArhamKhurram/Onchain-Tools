/** Smooth-scroll the landing page's snap container (`#landing-scroll`) back to the top. */
export function scrollLandingToTop() {
  document.getElementById('landing-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
}
