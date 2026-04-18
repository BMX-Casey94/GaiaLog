"use client"

import { useRef, useEffect } from "react"
import * as THREE from "three"

export const MeshCanvas = () => {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mountRef.current) return
    const mountElement = mountRef.current

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000)
    camera.position.z = 10
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.setPixelRatio(window.devicePixelRatio)
    mountElement.appendChild(renderer.domElement)

    const clock = new THREE.Clock()

    const isDarkMode = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches

    // --- Gravitational Mesh ---
    const geometry = new THREE.PlaneGeometry(40, 40, 50, 50)
    const material = new THREE.ShaderMaterial({
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

    const mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)

    const animate = () => {
      requestAnimationFrame(animate)
      const elapsedTime = clock.getElapsedTime()

      material.uniforms.uTime.value = elapsedTime

      mesh.rotation.x = -0.2
      mesh.rotation.z = Math.sin(elapsedTime * 0.1) * 0.05

      renderer.render(scene, camera)
    }
    animate()

    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight
      camera.updateProjectionMatrix()
      renderer.setSize(window.innerWidth, window.innerHeight)
    }
    window.addEventListener("resize", handleResize)

    return () => {
      window.removeEventListener("resize", handleResize)
      if (mountElement && renderer.domElement) {
        mountElement.removeChild(renderer.domElement)
      }
    }
  }, [])

  return <div ref={mountRef} className="absolute inset-0 z-0" />
}
