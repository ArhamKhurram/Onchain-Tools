import { useEffect, useRef, useState } from 'react';

/**
 * Full-bleed WebGL flame flow-field behind the hero headline.
 *
 * Raw WebGL in a single <canvas> — no three.js, no libraries. A domain-warped
 * fbm noise field animated as rising flame, rendered ONLY in the brand palette
 * (flame #ff1744 → white embers, dark flame veins for depth). Subtle cursor
 * reactivity. Falls back to a static CSS gradient when the user prefers reduced
 * motion or on small screens (no render loop on phones).
 */

const FRAGMENT_SHADER = `
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform vec2 u_mouse;      // 0..1, y up
uniform float u_mouseAmt;  // eased cursor presence 0..1

// Brand palette
const vec3 FLAME = vec3(1.0, 0.0902, 0.2667); // #ff1744
const vec3 WHITE = vec3(1.0);

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    v += amp * noise(p);
    p *= 2.02;
    amp *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float aspect = u_resolution.x / u_resolution.y;
  vec2 p = uv;
  p.x *= aspect;

  float t = u_time * 0.06;

  // Rising flame: scroll the field upward, warp the domain with itself.
  vec2 q = vec2(fbm(p * 2.2 + vec2(0.0, -t * 2.0)),
                fbm(p * 2.2 + vec2(5.2, 1.3 - t * 2.0)));
  vec2 warp = p + 0.55 * q + vec2(0.0, -t * 1.6);

  // Cursor warp — gently pull the field toward the cursor.
  vec2 m = u_mouse; m.x *= aspect;
  float md = distance(warp, m);
  warp += (m - warp) * 0.06 * u_mouseAmt * smoothstep(0.9, 0.0, md);

  float f = fbm(warp * 3.0);
  f = f * 1.15 - 0.05;

  // Base is flame red; low regions become dark flame veins for depth.
  vec3 col = mix(FLAME * 0.22, FLAME, smoothstep(0.18, 0.62, f));
  // Hot tips ember toward white.
  col = mix(col, WHITE, smoothstep(0.66, 0.94, f) * 0.85);

  // Cursor ember — a soft warm brightening near the pointer.
  col = mix(col, mix(FLAME, WHITE, 0.5), smoothstep(0.28, 0.0, md) * 0.18 * u_mouseAmt);

  // Vignette: keep the centre (behind the headline) bright, edges deeper.
  vec2 c = uv - 0.5; c.x *= aspect;
  float r = length(c);
  col *= mix(1.0, 0.62, smoothstep(0.35, 1.05, r));

  // Faint scanline-free grain to avoid banding.
  col += (hash(gl_FragCoord.xy + u_time) - 0.5) * 0.02;

  gl_FragColor = vec4(col, 1.0);
}
`;

const VERTEX_SHADER = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function HeroCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [useStatic, setUseStatic] = useState(true);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const small = window.matchMedia('(max-width: 640px)').matches;
    if (reduced || small) {
      setUseStatic(true);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    let dispose: (() => void) | null = null;

    const init = (): boolean => {
      const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
      if (!gl) return false;
      dispose = setup(canvas, gl);
      return dispose !== null;
    };

    // Browsers can refuse a WebGL context for a hidden document (e.g. the site
    // opened in a background tab). Defer init until the page is visible rather
    // than locking in the static fallback.
    if (!document.hidden) {
      if (!init()) setUseStatic(true);
    } else {
      const onVisible = () => {
        if (document.hidden) return;
        document.removeEventListener('visibilitychange', onVisible);
        if (!init()) setUseStatic(true);
      };
      document.addEventListener('visibilitychange', onVisible);
      dispose = () => document.removeEventListener('visibilitychange', onVisible);
    }

    return () => {
      dispose?.();
    };
  }, []);

  return (
    <div className="absolute inset-0 -z-0 overflow-hidden" aria-hidden>
      {/* Static brand-gradient fallback: reduced-motion, small screens, no WebGL. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 90% at 50% 35%, #ff5470 0%, #ff1744 42%, #7a0a20 100%)',
          opacity: useStatic ? 1 : 0,
          transition: 'opacity 600ms ease',
        }}
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ opacity: useStatic ? 0 : 1, transition: 'opacity 800ms ease' }}
      />
    </div>
  );
}

/** Compile, link, and drive the flame field. Returns a cleanup fn, or null on failure. */
function setup(canvas: HTMLCanvasElement, gl: WebGLRenderingContext): (() => void) | null {
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    if (!prog) return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;

    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // Fullscreen triangle
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, 'u_resolution');
    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uMouse = gl.getUniformLocation(prog, 'u_mouse');
    const uMouseAmt = gl.getUniformLocation(prog, 'u_mouseAmt');

    // Cap DPR for perf — the field is soft, high-DPI adds cost with no benefit.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let width = 0;
    let height = 0;
    const resize = () => {
      const w = Math.floor(canvas.clientWidth * dpr);
      const h = Math.floor(canvas.clientHeight * dpr);
      if (w === width && h === height) return;
      width = w;
      height = h;
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    };
    resize();
    window.addEventListener('resize', resize);

    // Eased mouse in 0..1 (y up). Target defaults to centre.
    let mx = 0.5;
    let my = 0.5;
    let tx = 0.5;
    let ty = 0.5;
    let amt = 0;
    let tAmt = 0;
    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      tx = (e.clientX - rect.left) / rect.width;
      ty = 1 - (e.clientY - rect.top) / rect.height;
      tAmt = 1;
    };
    const onLeave = () => {
      tAmt = 0;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerleave', onLeave);

    let raf = 0;
    let visible = true;
    const start = performance.now();
    const render = (now: number) => {
      if (visible) {
        resize();
        mx += (tx - mx) * 0.06;
        my += (ty - my) * 0.06;
        amt += (tAmt - amt) * 0.04;
        gl.uniform2f(uRes, width, height);
        gl.uniform1f(uTime, (now - start) / 1000);
        gl.uniform2f(uMouse, mx, my);
        gl.uniform1f(uMouseAmt, amt);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    // Pause when the hero scrolls out of view (perf on a scroll-snap page).
    const io = new IntersectionObserver(
      (entries) => {
        visible = entries[0]?.isIntersecting ?? true;
      },
      { threshold: 0.01 },
    );
    io.observe(canvas);

    const onHidden = () => {
      visible = !document.hidden;
    };
    document.addEventListener('visibilitychange', onHidden);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onHidden);
      io.disconnect();
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
}
