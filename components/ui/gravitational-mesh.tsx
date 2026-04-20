"use client"

import { useRef, useEffect } from "react"
import * as THREE from "three"

export const MeshCanvas = () => {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mountRef.current) return
    const mountElement = mountRef.current

    let rafId: number | null = null
    let renderer: THREE.WebGLRenderer | null = null
    let geometry: THREE.PlaneGeometry | null = null
    let material: THREE.ShaderMaterial | null = null
    let mesh: THREE.Mesh | null = null
    let scene: THREE.Scene | null = null
    let canvas: HTMLCanvasElement | null = null
    let contextLost = false

    const handleContextLost = (event: Event) => {
      // Stop the render loop immediately so we don't keep poking a dead
      // GL context (which throws and unmounts the entire React tree).
      event.preventDefault()
      contextLost = true
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
    }

    const handleResize = () => {
      if (!renderer || contextLost) return
      try {
        const cam = (scene?.userData as { camera?: THREE.PerspectiveCamera } | undefined)?.camera
        if (cam) {
          cam.aspect = window.innerWidth / window.innerHeight
          cam.updateProjectionMatrix()
        }
        renderer.setSize(window.innerWidth, window.innerHeight)
      } catch {
        // Resize failures are non-fatal; ignore.
      }
    }

    try {
      scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000)
      camera.position.z = 10
      scene.userData.camera = camera

      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "low-power",
        // Surrendering the back-buffer aggressively reduces the chance that
        // the browser's WebGL context budget gets exhausted on long sessions.
        preserveDrawingBuffer: false,
      })
      renderer.setSize(window.innerWidth, window.innerHeight)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

      canvas = renderer.domElement
      canvas.addEventListener("webglcontextlost", handleContextLost, false)
      mountElement.appendChild(canvas)

      const clock = new THREE.Clock()

      const isDarkMode =
        typeof window !== "undefined" &&
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches

      geometry = new THREE.PlaneGeometry(40, 40, 50, 50)
      material = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uColor: { value: new THREE.Color(isDarkMode ? 0xa0a0ff : 0x404080) },
        },
        vertexShader: `
            uniform float uTime;
            varying float vIntensity;

            void main() {
                vec3 pos = position;

                float centerDist = distance(pos.xy, vec2(0.0, 0.0));
                float warp = 1.0 - smoothstep(0.0, 8.0, centerDist);
                pos.z += warp * 2.0;
                vIntensity = warp * 0.5 + 0.3;

                pos.z += sin(pos.x * 0.3 + uTime * 0.8) * 0.2;
                pos.z += cos(pos.y * 0.3 + uTime * 0.6) * 0.15;

                gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 uColor;
            varying float vIntensity;
            void main() {
                gl_FragColor = vec4(uColor * vIntensity, vIntensity * 0.4);
            }
        `,
        wireframe: true,
        transparent: true,
        blending: isDarkMode ? THREE.AdditiveBlending : THREE.NormalBlending,
      })

      mesh = new THREE.Mesh(geometry, material)
      scene.add(mesh)

      const animate = () => {
        if (contextLost || !renderer || !material || !mesh || !scene) return
        rafId = requestAnimationFrame(animate)
        try {
          const elapsedTime = clock.getElapsedTime()
          ;(material.uniforms.uTime as { value: number }).value = elapsedTime
          mesh.rotation.x = -0.2
          mesh.rotation.z = Math.sin(elapsedTime * 0.1) * 0.05
          renderer.render(scene, camera)
        } catch {
          // If the renderer throws (typically because the GL context was
          // lost mid-frame), bail out of the loop rather than spamming.
          contextLost = true
          if (rafId !== null) {
            cancelAnimationFrame(rafId)
            rafId = null
          }
        }
      }
      animate()

      window.addEventListener("resize", handleResize)
    } catch {
      // If WebGL is unavailable (driver issue, headless, blocklist) or the
      // shader fails to compile, bail silently. The hero still renders, the
      // background is just a solid gradient. Crucially we do NOT re-throw,
      // because that would unmount the React tree and break SPA navigation.
      contextLost = true
    }

    return () => {
      window.removeEventListener("resize", handleResize)
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      if (canvas) {
        canvas.removeEventListener("webglcontextlost", handleContextLost)
        if (canvas.parentNode === mountElement) {
          try {
            mountElement.removeChild(canvas)
          } catch {
            // Element may have already been detached during fast unmount.
          }
        }
      }
      // Free GPU resources so repeated visits to the home page don't
      // accumulate WebGL contexts (browsers cap them at ~16).
      try {
        geometry?.dispose()
      } catch {}
      try {
        material?.dispose()
      } catch {}
      try {
        renderer?.dispose()
        renderer?.forceContextLoss()
      } catch {}
      scene = null
      mesh = null
      material = null
      geometry = null
      renderer = null
      canvas = null
    }
  }, [])

  return <div ref={mountRef} className="absolute inset-0 z-0" />
}
