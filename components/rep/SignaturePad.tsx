"use client";
// Signature pad (PRD REP-6, required for a sale). Drawn with the finger on a canvas, exported as a PNG.
import { Eraser } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";

export type SignaturePadHandle = { toBlob: () => Promise<Blob | null>; clear: () => void };

export const SignaturePad = forwardRef<SignaturePadHandle, { onChange: (empty: boolean) => void; error?: string | null }>(function SignaturePad({ onChange, error }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  // Size the canvas to its box, at device resolution, and paint paper.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }, []);

  const point = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = point(e);
    ctx.strokeStyle = "black"; // a signature is a document: always ink on paper, in any theme
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.01, p.y + 0.01);
    ctx.stroke();
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (empty) {
      setEmpty(false);
      onChange(false);
    }
  }
  function up() {
    drawing.current = false;
  }

  const clear = () => {
    const canvas = canvasRef.current!;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    setEmpty(true);
    onChange(true);
  };

  useImperativeHandle(ref, () => ({
    clear,
    toBlob: () =>
      new Promise<Blob | null>((resolve) => {
        // Export on a white background so the strokes show wherever the file is opened.
        const src = canvasRef.current!;
        const out = document.createElement("canvas");
        out.width = src.width;
        out.height = src.height;
        const ctx = out.getContext("2d")!;
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(src, 0, 0);
        out.toBlob(resolve, "image/png");
      }),
  }));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-label">Signature</span>
        <Button variant="quiet" size="rep" onClick={clear} disabled={empty} aria-label="Clear signature">
          <Eraser aria-hidden="true" size={20} />
          Clear
        </Button>
      </div>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Signature pad. Sign with your finger."
        data-testid="signature-pad"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        className="h-40 w-full touch-none rounded-sm border-2 border-line-strong bg-[var(--paper)]"
      />
      {error && <p className="text-caption text-danger">{error}</p>}
    </div>
  );
});
