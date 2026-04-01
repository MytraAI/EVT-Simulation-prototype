import { useEffect, useRef, useMemo } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useStore } from "../store";
import { useDisplayState } from "../hooks/useDisplayState";
import type { GraphNode, NodeKind } from "../graph/types";
import { KIND_HEX } from "../graph/types";

const LEVEL_HEIGHT = 2.5;

const NODE_HEIGHTS: Record<NodeKind, number> = {
  AISLE_CELL: 0.05,
  PALLET_POSITION: 0.15,
  Z_COLUMN: LEVEL_HEIGHT * 0.8,
  STATION_XY: 0.4,
  STATION_OP: 0.6,
  STATION_PEZ: 0.5,
};

const NODE_OPACITY: Record<NodeKind, number> = {
  AISLE_CELL: 0.2,
  PALLET_POSITION: 0.4,
  Z_COLUMN: 0.6,
  STATION_XY: 0.9,
  STATION_OP: 0.9,
  STATION_PEZ: 0.9,
};

const BOT_COLORS = [
  0x00e5ff, 0xff6d00, 0x76ff03, 0xd500f9, 0xffea00,
  0xff1744, 0x00b0ff, 0x1de9b6, 0xff9100, 0xf50057,
];

export function WarehouseScene() {
  const graph = useStore((s) => s.graph);
  const simState = useDisplayState();
  const setSelectedNodeId = useStore((s) => s.setSelectedNodeId);

  const nodesByKind = useMemo(() => {
    if (!graph) return new Map<NodeKind, GraphNode[]>();
    const map = new Map<NodeKind, GraphNode[]>();
    for (const node of graph.data.nodes) {
      const kind = node.kind as NodeKind;
      if (!map.has(kind)) map.set(kind, []);
      map.get(kind)!.push(node);
    }
    return map;
  }, [graph]);

  const edgeGeom = useMemo(() => {
    if (!graph) return null;
    const positions: number[] = [];
    for (const edge of graph.data.edges) {
      const a = graph.nodeMap.get(edge.a);
      const b = graph.nodeMap.get(edge.b);
      if (!a || !b) continue;
      const ay = (a.level - 1) * LEVEL_HEIGHT;
      const by = (b.level - 1) * LEVEL_HEIGHT;
      positions.push(a.position.x_m, ay + 0.02, a.position.y_m);
      positions.push(b.position.x_m, by + 0.02, b.position.y_m);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geom;
  }, [graph]);

  if (!graph) return null;

  return (
    <group>
      {/* Static structure nodes */}
      {Array.from(nodesByKind.entries()).map(([kind, nodes]) => (
        <NodeInstances
          key={kind}
          kind={kind}
          nodes={nodes}
          onSelect={setSelectedNodeId}
        />
      ))}

      {/* Occupied pallet positions (colored by SKU) */}
      {simState && <PalletInstances />}

      {/* Edges */}
      {edgeGeom && (
        <lineSegments geometry={edgeGeom}>
          <lineBasicMaterial color={0x374151} opacity={0.4} transparent />
        </lineSegments>
      )}

      {/* Animated bots */}
      {simState && <BotMeshes />}

      {/* Physical columns */}
      {graph.data.metadata?.physical?.columns?.map((col) => (
        <mesh key={col.id} position={[col.x_m, 0.5, col.y_m]}>
          <boxGeometry args={[col.width_m, 1.0, col.depth_m]} />
          <meshStandardMaterial color={0x6b7280} opacity={0.5} transparent />
        </mesh>
      ))}
    </group>
  );
}

// --- Pallet instances (colored by SKU) ---

function PalletInstances() {
  const graph = useStore((s) => s.graph);
  const simState = useDisplayState();
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const colorRef = useRef<THREE.InstancedBufferAttribute | null>(null);

  const palletEntries = useMemo(() => {
    if (!simState || !graph) return [];
    return Array.from(simState.pallets.entries())
      .map(([nodeId, pallet]) => ({ nodeId, pallet, node: graph.nodeMap.get(nodeId)! }))
      .filter((e) => e.node);
  }, [simState, graph]);

  const skuColorMap = useMemo(() => {
    if (!simState) return new Map<string, THREE.Color>();
    const map = new Map<string, THREE.Color>();
    for (const info of simState.skuCatalog) {
      map.set(info.sku, new THREE.Color(info.color));
    }
    return map;
  }, [simState?.skuCatalog]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || palletEntries.length === 0) return;

    const dummy = new THREE.Object3D();
    const colors = new Float32Array(palletEntries.length * 3);

    for (let i = 0; i < palletEntries.length; i++) {
      const { node, pallet } = palletEntries[i];
      const yOffset = (node.level - 1) * LEVEL_HEIGHT + 0.25;
      dummy.position.set(node.position.x_m, yOffset, node.position.y_m);
      dummy.scale.set(node.size_x_m * 0.85, 0.35, node.size_y_m * 0.85);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const color = skuColorMap.get(pallet.sku) ?? new THREE.Color(0xffffff);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }

    mesh.instanceMatrix.needsUpdate = true;

    // Per-instance colors
    const attr = new THREE.InstancedBufferAttribute(colors, 3);
    mesh.geometry.setAttribute("color", attr);
    colorRef.current = attr;
  }, [palletEntries, skuColorMap]);

  if (palletEntries.length === 0) return null;

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, palletEntries.length]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        vertexColors
        opacity={0.9}
        transparent
        roughness={0.5}
        metalness={0.1}
      />
    </instancedMesh>
  );
}

// --- Animated bot meshes ---

function BotMeshes() {
  const graph = useStore((s) => s.graph);
  const simState = useDisplayState();
  const groupRef = useRef<THREE.Group>(null!);
  const botRefs = useRef<Map<number, THREE.Mesh>>(new Map());
  const carryRefs = useRef<Map<number, THREE.Mesh>>(new Map());

  useFrame(() => {
    if (!graph || !simState) return;

    for (const bot of simState.bots) {
      const mesh = botRefs.current.get(bot.id);
      if (!mesh) continue;

      const curNode = graph.nodeMap.get(bot.currentNodeId);
      const prevNode = graph.nodeMap.get(bot.prevNodeId);
      if (!curNode) continue;

      // Interpolate position
      const t = bot.moveProgress;
      let tx: number, ty: number, tz: number;

      if (prevNode && t < 1) {
        tx = prevNode.position.x_m + (curNode.position.x_m - prevNode.position.x_m) * t;
        const prevY = (prevNode.level - 1) * LEVEL_HEIGHT + 0.5;
        const curY = (curNode.level - 1) * LEVEL_HEIGHT + 0.5;
        ty = prevY + (curY - prevY) * t;
        tz = prevNode.position.y_m + (curNode.position.y_m - prevNode.position.y_m) * t;
      } else {
        tx = curNode.position.x_m;
        ty = (curNode.level - 1) * LEVEL_HEIGHT + 0.5;
        tz = curNode.position.y_m;
      }

      // Smooth lerp toward target
      mesh.position.x += (tx - mesh.position.x) * 0.2;
      mesh.position.y += (ty - mesh.position.y) * 0.2;
      mesh.position.z += (tz - mesh.position.z) * 0.2;

      // Carrying indicator
      const carry = carryRefs.current.get(bot.id);
      if (carry) {
        const isCarrying =
          bot.state === "TRAVELING_TO_DROPOFF" || bot.state === "EDGE_WAIT_DROP" || bot.state === "PLACING";
        carry.visible = isCarrying;
        carry.position.copy(mesh.position);
        carry.position.y += 0.25;
      }
    }
  });

  if (!simState) return null;

  return (
    <group ref={groupRef}>
      {simState.bots.map((bot) => {
        const color = BOT_COLORS[bot.id % BOT_COLORS.length];
        const node = graph?.nodeMap.get(bot.currentNodeId);
        const initPos: [number, number, number] = node
          ? [node.position.x_m, (node.level - 1) * LEVEL_HEIGHT + 0.5, node.position.y_m]
          : [0, 0.5, 0];

        return (
          <group key={bot.id}>
            <mesh
              ref={(ref) => {
                if (ref) botRefs.current.set(bot.id, ref);
              }}
              position={initPos}
            >
              <boxGeometry args={[0.4, 0.3, 0.4]} />
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={0.4}
                roughness={0.3}
                metalness={0.5}
              />
            </mesh>
            <mesh
              ref={(ref) => {
                if (ref) carryRefs.current.set(bot.id, ref);
              }}
              position={initPos}
              visible={false}
            >
              <boxGeometry args={[0.35, 0.15, 0.35]} />
              <meshStandardMaterial color={0xffca28} opacity={0.85} transparent />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

// --- Static structure node instances ---

type NodeInstancesProps = {
  kind: NodeKind;
  nodes: GraphNode[];
  onSelect: (id: string | null) => void;
};

function NodeInstances({ kind, nodes, onSelect }: NodeInstancesProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const color = KIND_HEX[kind];
  const height = NODE_HEIGHTS[kind];
  const opacity = NODE_OPACITY[kind];

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const yOffset = (node.level - 1) * LEVEL_HEIGHT + height / 2;
      dummy.position.set(node.position.x_m, yOffset, node.position.y_m);
      dummy.scale.set(node.size_x_m, height, node.size_y_m);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [nodes, height]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, nodes.length]}
      onClick={(e) => {
        e.stopPropagation();
        const idx = e.instanceId;
        if (idx !== undefined && idx < nodes.length) {
          onSelect(nodes[idx].id);
        }
      }}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        color={color}
        opacity={opacity}
        transparent={opacity < 1}
        roughness={0.6}
        metalness={0.1}
      />
    </instancedMesh>
  );
}
