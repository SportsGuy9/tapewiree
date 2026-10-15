"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { client, fmt } from "@/lib/api";

const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"].map((h) => new THREE.Color(h));

/** Downsampled 3D view. Colour = height (sequential), setups as markers. */
export default function PointViewer({
  projectId,
  setups,
  floorZ,
}: {
  projectId: string;
  setups: { label: string; x: number; y: number }[];
  floorZ: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const panel = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim().split(/\s+/).map(Number);
    renderer.setClearColor(new THREE.Color(`rgb(${panel.join(",")})`));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 5000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    let raf = 0;
    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    client
      .points(projectId)
      .then((arr) => {
        if (disposed) return;
        const n = arr.length / 3;
        setCount(n);
        if (!n) return;
        // centre on the bounding box to keep float precision (site coords can be large)
        let mn = [Infinity, Infinity, Infinity];
        let mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < n; i++)
          for (let a = 0; a < 3; a++) {
            const v = arr[i * 3 + a];
            if (v < mn[a]) mn[a] = v;
            if (v > mx[a]) mx[a] = v;
          }
        const c = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, mn[2]];
        const pos = new Float32Array(n * 3);
        const col = new Float32Array(n * 3);
        const zr = Math.max(mx[2] - mn[2], 0.1);
        const tmp = new THREE.Color();
        for (let i = 0; i < n; i++) {
          // three.js is Y-up: map (x, y, z) → (x, z, -y)
          pos[i * 3] = arr[i * 3] - c[0];
          pos[i * 3 + 1] = arr[i * 3 + 2] - c[2];
          pos[i * 3 + 2] = -(arr[i * 3 + 1] - c[1]);
          const t = Math.min(0.999, Math.max(0, (arr[i * 3 + 2] - mn[2]) / zr)) * (RAMP.length - 1);
          const j = Math.floor(t);
          tmp.copy(RAMP[j]).lerp(RAMP[j + 1], t - j);
          col[i * 3] = tmp.r;
          col[i * 3 + 1] = tmp.g;
          col[i * 3 + 2] = tmp.b;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        g.setAttribute("color", new THREE.BufferAttribute(col, 3));
        scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 0.04, vertexColors: true, sizeAttenuation: true })));
        const mat = new THREE.MeshBasicMaterial({ color: 0x1f2328 });
        for (const s of setups) {
          const m = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.5, 12), mat);
          m.position.set(s.x - c[0], floorZ - c[2] + 0.75, -(s.y - c[1]));
          scene.add(m);
        }
        const span = Math.max(mx[0] - mn[0], mx[1] - mn[1]);
        camera.position.set(span * 0.55, span * 0.7, span * 0.75);
        controls.target.set(0, zr * 0.3, 0);
        controls.update();
      })
      .catch((e) => setErr(String(e)));

    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
      });
      el.removeChild(renderer.domElement);
    };
  }, [projectId, setups, floorZ]);

  return (
    <div>
      <div ref={ref} className="h-[420px] w-full overflow-hidden rounded border border-line" aria-label="3D point cloud preview" />
      <p className="mt-1 text-xs text-muted">
        {err ? <span className="text-sev-high">{err}</span> : count == null ? "Loading sample…" : <>Random sample of <span className="num">{fmt.int(count)}</span> points, coloured by height. Drag to orbit, scroll/pinch to zoom.</>}
      </p>
    </div>
  );
}
