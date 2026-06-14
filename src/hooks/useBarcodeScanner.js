// src/hooks/useBarcodeScanner.js
import { useState, useEffect, useRef, useCallback } from "react";
import { BrowserMultiFormatReader } from "@zxing/library";

// ── Camera scanner ──────────────────────────────────────────
export function useCameraScanner(onDetected) {
  const videoRef = useRef(null);
  const readerRef = useRef(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState(null);

  const start = useCallback(async () => {
    try {
      setError(null);
      readerRef.current = new BrowserMultiFormatReader();
      const devices = await readerRef.current.listVideoInputDevices();
      // prefer back camera on mobile
      const device = devices.find(d => /back|rear|environment/i.test(d.label)) || devices[0];
      if (!device) throw new Error("לא נמצאה מצלמה");

      await readerRef.current.decodeFromVideoDevice(
        device.deviceId,
        videoRef.current,
        (result, err) => {
          if (result) {
            onDetected(result.getText());
            stop();
          }
        }
      );
      setActive(true);
    } catch (e) {
      setError(e.message);
      setActive(false);
    }
  }, [onDetected]);

  const stop = useCallback(() => {
    if (readerRef.current) {
      readerRef.current.reset();
    }
    setActive(false);
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { videoRef, active, error, start, stop };
}

// ── USB / keyboard wedge scanner ───────────────────────────
// USB scanners type the barcode + Enter/Tab very fast.
// We buffer keystrokes and emit when Enter arrives.
export function useUSBScanner(onDetected) {
  const bufferRef = useRef("");
  const timerRef = useRef(null);

  useEffect(() => {
    function onKeyDown(e) {
      // Ignore when typing in an input/select/textarea
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      if (e.key === "Enter" || e.key === "Tab") {
        const val = bufferRef.current.trim();
        if (val.length >= 4) onDetected(val);
        bufferRef.current = "";
        clearTimeout(timerRef.current);
        return;
      }

      if (e.key.length === 1) {
        bufferRef.current += e.key;
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => { bufferRef.current = ""; }, 300);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDetected]);
}
