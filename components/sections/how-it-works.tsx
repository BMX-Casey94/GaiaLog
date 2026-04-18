"use client"

import React, { useRef, useEffect, useState } from 'react';
import { RippleButton } from "@/components/ui/multi-type-ripple-buttons";
import { Globe, Database, Shield, ArrowRight, CheckCircle } from "lucide-react";

// --- Internal Helper Components --- //

const CheckIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16" height="16" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="3"
    strokeLinecap="round" strokeLinejoin="round"
    className={className}
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const ShaderCanvas = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glProgramRef = useRef<WebGLProgram | null>(null);
  const glBgColorLocationRef = useRef<WebGLUniformLocation | null>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const [backgroundColor, setBackgroundColor] = useState([0.0, 0.0, 0.0]);

  useEffect(() => {
    const root = document.documentElement;
    const updateColor = () => {
      const isDark = root.classList.contains('dark');
      setBackgroundColor(isDark ? [0, 0, 0] : [1.0, 1.0, 1.0]);
    };
    updateColor();
    const observer = new MutationObserver((mutationsList) => {
      for (const mutation of mutationsList) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          updateColor();
        }
      }
    });
    observer.observe(root, { attributes: true });
    return () => observer.disconnect();
  }, [backgroundColor]);

  useEffect(() => {
    const gl = glRef.current;
    const program = glProgramRef.current;
    const location = glBgColorLocationRef.current;
    if (gl && program && location) {
      gl.useProgram(program);
      gl.uniform3fv(location, new Float32Array(backgroundColor));
    }
  }, [backgroundColor]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl');
    if (!gl) { console.error("WebGL not supported"); return; }
    glRef.current = gl;

    const vertexShaderSource = `attribute vec2 aPosition; void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }`;
    const fragmentShaderSource = `
      precision highp float;
      uniform float iTime;
      uniform vec2 iResolution;
      uniform vec3 uBackgroundColor;
      mat2 rotate2d(float angle){ float c=cos(angle),s=sin(angle); return mat2(c,-s,s,c); }
      float variation(vec2 v1,vec2 v2,float strength,float speed){ return sin(dot(normalize(v1),normalize(v2))*strength+iTime*speed)/100.0; }
      vec3 paintCircle(vec2 uv,vec2 center,float rad,float width){
        vec2 diff = center-uv;
        diff.x *= iResolution.x / iResolution.y; // aspect-correct distance
        float len = length(diff);
        len += variation(diff,vec2(0.,1.),5.,2.);
        len -= variation(diff,vec2(1.,0.),5.,2.);
        float circle = smoothstep(rad-width,rad,len)-smoothstep(rad,rad+width,len);
        return vec3(circle);
      }
      void main(){
        vec2 uv0 = gl_FragCoord.xy / iResolution.xy;
        // Keep the ring perfectly circular by computing mask in unscaled space
        float mask = 0.0;
        float radius = .35;
        vec2 center = vec2(.5);
        mask += paintCircle(uv0,center,radius,.035).r * 0.6;
        mask += paintCircle(uv0,center,radius-.018,.01).r * 0.6;
        mask += paintCircle(uv0,center,radius+.018,.005).r * 0.6;

        // Only widen the color field on desktop; does not affect circle geometry
        float aspect = iResolution.x / iResolution.y;
        float widen = smoothstep(1.1, 1.6, aspect);
        float xScale = mix(1.0, 2.1, widen); // up to ~40% wider on desktop
        float xOffset = 0.5 * (xScale - 1.0);
        vec2 uvColor = uv0;
        uvColor.x = uvColor.x * xScale - xOffset;
        vec2 v=rotate2d(iTime)*uvColor;
        vec3 foregroundColor=vec3(v.x,v.y,.7-v.y*v.x);
        vec3 color=mix(uBackgroundColor,foregroundColor,mask);
        color=mix(color,vec3(1.),paintCircle(uv0,center,radius,.003).r);
        gl_FragColor=vec4(color,1.);
      }`;

    const compileShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Could not create shader");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) || "Shader compilation error");
      }
      return shader;
    };

    const program = gl.createProgram();
    if (!program) throw new Error("Could not create program");
    const vertexShader = compileShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.useProgram(program);
    glProgramRef.current = program;

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const aPosition = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    const iTimeLoc = gl.getUniformLocation(program, 'iTime');
    const iResLoc = gl.getUniformLocation(program, 'iResolution');
    glBgColorLocationRef.current = gl.getUniformLocation(program, 'uBackgroundColor');
    gl.uniform3fv(glBgColorLocationRef.current, new Float32Array(backgroundColor));

    let animationFrameId: number;
    const render = (time: number) => {
      gl.uniform1f(iTimeLoc, time * 0.001);
      gl.uniform2f(iResLoc, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      animationFrameId = requestAnimationFrame(render);
    };
    const handleResize = () => {
      const dpr = window.devicePixelRatio || 1.0;
      const rect = canvas.getBoundingClientRect();
      const targetWidth = Math.max(1, Math.floor(rect.width * dpr));
      const targetHeight = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    animationFrameId = requestAnimationFrame(render);
    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameId);
    };
  }, [backgroundColor]);

  return <canvas ref={canvasRef} className="absolute top-0 left-0 w-full h-full block z-0" />;
};

// --- Workflow Step Card Component --- //

interface WorkflowStepProps {
  stepNumber: number;
  title: string;
  description: string;
  icon: React.ReactNode;
  features: string[];
  isActive?: boolean;
}

const WorkflowStepCard = ({
  stepNumber,
  title,
  description,
  icon,
  features,
  isActive = false
}: WorkflowStepProps) => {
  const cardClasses = `
    backdrop-blur-[14px] bg-gradient-to-br rounded-2xl shadow-xl w-full max-w-full md:max-w-xs px-7 py-8 flex flex-col transition-all duration-300
    from-black/5 to-black/0 border border-black/10
    dark:from-white/10 dark:to-white/5 dark:border-white/10 dark:backdrop-brightness-[0.91]
    ${isActive ? 'scale-105 relative ring-2 ring-cyan-400/20 dark:from-white/20 dark:to-white/10 dark:border-cyan-400/30 shadow-2xl' : ''}
  `;

  return (
    <div className={cardClasses.trim()}>
      {isActive && (
        <div className="absolute -top-4 right-4 px-3 py-1 text-[12px] font-semibold rounded-full bg-cyan-400 text-foreground dark:text-black">
          Active
        </div>
      )}
      
      <div className="flex items-center gap-3 mb-4">
        <div className="w-12 h-12 bg-cyan-400/20 rounded-full flex items-center justify-center">
          {icon}
        </div>
        <div className="flex-1">
          <div className="text-sm text-cyan-400 font-medium">Step {stepNumber}</div>
          <h3 className="text-xl font-semibold text-foreground">{title}</h3>
        </div>
      </div>
      
      <p className="text-[16px] text-foreground/70 mb-6 font-sans">{description}</p>
      
      <div className="card-divider w-full mb-5 h-px bg-[linear-gradient(90deg,transparent,rgba(0,0,0,0.1)_50%,transparent)] dark:bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.09)_20%,rgba(255,255,255,0.22)_50%,rgba(255,255,255,0.09)_80%,transparent)]"></div>
      
      <ul className="flex flex-col gap-2 text-[14px] text-foreground/90 mb-6 font-sans">
        {features.map((feature, index) => (
          <li key={index} className="flex items-center gap-2">
            <CheckIcon className="text-cyan-400 w-4 h-4" /> {feature}
          </li>
        ))}
      </ul>
    </div>
  );
};

// --- Main Component --- //

export function HowItWorks() {
  const workflowSteps: WorkflowStepProps[] = [
    {
      stepNumber: 1,
      title: "Data Collection",
      description: "Environmental sensors and APIs provide real-time data every 15-60 minutes",
      icon: <Globe className="h-6 w-6 text-cyan-400" />,
      features: [
        "Air quality monitoring",
        "Water level tracking", 
        "Seismic activity detection",
        "Weather data collection"
      ],
      isActive: true
    },
    {
      stepNumber: 2,
      title: "GaiaLog Processing",
      description: "Data is validated, formatted, and prepared for blockchain storage",
      icon: <Database className="h-6 w-6 text-cyan-400" />,
      features: [
        "Data validation & checks",
        "Format standardisation",
        "Metadata enrichment",
        "Timestamp verification"
      ]
    },
    {
      stepNumber: 3,
      title: "BSV Blockchain",
      description: "Immutable storage with cryptographic verification and public auditability",
      icon: <Shield className="h-6 w-6 text-cyan-400" />,
      features: [
        "Cryptographic signing",
        "Immutable storage",
        "Public audit trail",
        "Transaction verification"
      ]
    },
    {
      stepNumber: 4,
      title: "Dashboard Display",
      description: "Real-time visualisation with blockchain transaction references",
      icon: <ArrowRight className="h-6 w-6 text-cyan-400" />,
      features: [
        "Real-time data visualisation",
        "Blockchain transaction links",
        "Historical data access",
        "Interactive charts & graphs"
      ]
    }
  ];

  return (
    <section id="how-it-works" className="relative min-h-screen w-full overflow-x-hidden py-20 scroll-mt-24">
      <ShaderCanvas />
      
      <div className="relative z-10 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <h2 className="text-[48px] md:text-[64px] font-extralight leading-tight tracking-[-0.03em] bg-clip-text text-transparent bg-gradient-to-r from-slate-900 via-cyan-500 to-blue-600 dark:from-white dark:via-cyan-300 dark:to-blue-400 font-display">
            How GaiaLog Works
          </h2>
        </div>

        {/* Workflow Steps */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 items-start md:justify-center">
          {workflowSteps.map((step, index) => (
            <WorkflowStepCard key={step.stepNumber} {...step} />
          ))}
        </div>

        {/* Why Blockchain Section */}
        <div className="mt-20">
          <div className="backdrop-blur-[14px] bg-gradient-to-br rounded-2xl shadow-xl max-w-4xl mx-auto px-8 py-10
            from-black/5 to-black/0 border border-black/10
            dark:from-white/10 dark:to-white/5 dark:border-white/10 dark:backdrop-brightness-[0.91]">
            
            <h3 className="text-2xl font-semibold text-foreground mb-6 text-center">
              Why Blockchain for Environmental Data?
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div className="text-center">
                <div className="w-16 h-16 bg-cyan-400/20 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Shield className="h-8 w-8 text-cyan-400" />
                </div>
                <h4 className="font-medium text-cyan-400 mb-2">Immutability</h4>
                <p className="text-sm text-foreground/70">Data cannot be altered or deleted once recorded</p>
              </div>
              
              <div className="text-center">
                <div className="w-16 h-16 bg-cyan-400/20 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Globe className="h-8 w-8 text-cyan-400" />
                </div>
                <h4 className="font-medium text-cyan-400 mb-2">Transparency</h4>
                <p className="text-sm text-foreground/70">All measurements are publicly verifiable</p>
              </div>
              
              <div className="text-center">
                <div className="w-16 h-16 bg-cyan-400/20 rounded-full flex items-center justify-center mx-auto mb-4">
                  <CheckCircle className="h-8 w-8 text-cyan-400" />
                </div>
                <h4 className="font-medium text-cyan-400 mb-2">Trust</h4>
                <p className="text-sm text-foreground/70">No single point of failure or data manipulation</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
