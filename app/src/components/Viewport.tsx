import { useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import {
  OrbitControls,
  OrthographicCamera,
  PerspectiveCamera,
} from "@react-three/drei";
import { useStore } from "../store";
import { WarehouseScene } from "./WarehouseScene";
import { Viewport2D } from "./Viewport2D";

export function Viewport() {
  const graph = useStore((s) => s.graph);
  const cameraMode = useStore((s) => s.cameraMode);
  const [webglFailed, setWebglFailed] = useState(false);

  const center = useMemo(() => {
    if (!graph) return [0, 0, 0] as [number, number, number];
    const b = graph.bounds;
    return [
      (b.minX + b.maxX) / 2,
      0,
      (b.minY + b.maxY) / 2,
    ] as [number, number, number];
  }, [graph]);

  const extent = useMemo(() => {
    if (!graph) return 30;
    const b = graph.bounds;
    return Math.max(b.maxX - b.minX, b.maxY - b.minY, 10);
  }, [graph]);

  // 2D mode or WebGL unavailable
  if (cameraMode === "2d" || webglFailed) {
    return <Viewport2D />;
  }

  return (
    <Canvas
      className="!absolute inset-0"
      gl={{ antialias: true, failIfMajorPerformanceCaveat: false }}
      dpr={[1, 2]}
      onError={() => setWebglFailed(true)}
    >
      <color attach="background" args={["#111827"]} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[20, 30, 10]} intensity={0.8} />

      {cameraMode === "3d" && (
        <>
          <PerspectiveCamera
            makeDefault
            position={[
              center[0] + extent * 0.8,
              extent * 0.6,
              center[2] + extent * 0.8,
            ]}
            fov={50}
            near={0.1}
            far={1000}
          />
          <OrbitControls enableDamping target={center} />
        </>
      )}

      {cameraMode === "isometric" && (
        <>
          <OrthographicCamera
            makeDefault
            position={[
              center[0] + extent,
              extent * 0.8,
              center[2] + extent,
            ]}
            zoom={12}
            near={0.1}
            far={500}
          />
          <OrbitControls
            enableRotate={false}
            enableDamping
            target={center}
          />
        </>
      )}

      {graph && <WarehouseScene />}

      <gridHelper
        args={[100, 100, "#1f2937", "#1f2937"]}
        position={[center[0], -0.01, center[2]]}
      />
    </Canvas>
  );
}
