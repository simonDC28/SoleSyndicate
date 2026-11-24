
import { useState, useRef, useEffect } from "react";
import "./AiShoeScanner.css";

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const base64 = reader.result.split(",")[1];

      resolve({
        base64,
        mimeType: file.type || "image/jpeg",
        previewUrl: reader.result,
      });
    };

    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function analyzeSneakerWithGemini({
  base64,
  mimeType,
  expectedModel,
}) {
  if (!GEMINI_API_KEY) {
    await new Promise((r) => setTimeout(r, 1400));

    return {
      isDemo: true,
      verdict: "INCONCLUSIVE",
      confidence: 0,
      detectedModel: expectedModel || "Demo scan only",
      extractedBarcodeOrSku: "Not analyzed",
      checks: [
        {
          area: "Silhouette & Toe-Box Form",
          passed: false,
          detail: "Demo mode. Configure your Gemini API key for actual image analysis.",
        },
        {
          area: "Stitching & Materials",
          passed: false,
          detail: "No real authentication analysis was performed.",
        },
        {
          area: "Barcode / Size Tag & SKU",
          passed: false,
          detail: "No barcode verification was performed.",
        },
      ],
    };
  }

  const prompt = `You are a sneaker identification and visual inspection assistant.

${expectedModel ? `The user claims this sneaker is: "${expectedModel}".` : ""}

Analyze the supplied sneaker image.

Evaluate:
1. Silhouette and form: toe box, heel, midsole proportions and overall structure.
2. Construction: stitching, logo placement, material texture and visible glue lines.
3. Barcode and SKU: read visible UPC/EAN, QR codes, style codes and size tags.

Important:
- Do not claim that a shoe is authentic based on appearance alone.
- Do not invent barcode or SKU information.
- If the image is insufficient, return INCONCLUSIVE.
- Explain that visual inspection cannot guarantee authenticity.

Return ONLY valid JSON:
{
  "verdict": "AUTHENTIC" | "FAKE" | "INCONCLUSIVE",
  "confidence": 0,
  "detectedModel": "Detected shoe name and colorway",
  "extractedBarcodeOrSku": "Visible code or Not visible in photo",
  "checks": [
    {
      "area": "Silhouette & Form",
      "passed": false,
      "detail": "Explanation"
    },
    {
      "area": "Stitching & Materials",
      "passed": false,
      "detail": "Explanation"
    },
    {
      "area": "Barcode / Size Tag & SKU",
      "passed": false,
      "detail": "Explanation"
    }
  ]
}`;

  const response = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType,
                data: base64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.2,
      },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
      "Failed to analyze shoe image with Gemini API."
    );
  }

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!rawText) {
    throw new Error("Gemini returned an empty response. Please try again.");
  }

  return JSON.parse(rawText);
}

export default function AiShoeScanner() {
  const [isOpen, setIsOpen] = useState(false);
  const [imageData, setImageData] = useState(null);
  const [expectedModel, setExpectedModel] = useState("");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  // CAMERA STATES
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraStream, setCameraStream] = useState(null);
  const [facingMode, setFacingMode] = useState("environment");

  // REFERENCES
  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // CONNECT CAMERA STREAM TO VIDEO
  useEffect(() => {
    if (cameraActive && cameraStream && videoRef.current) {
      videoRef.current.srcObject = cameraStream;

      videoRef.current.play().catch(() => {
        setError("Unable to start camera preview.");
      });
    }
  }, [cameraActive, cameraStream]);

  // STOP CAMERA
  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
    }

    setCameraStream(null);
    setCameraActive(false);
  };

  // CLEAN UP CAMERA WHEN COMPONENT UNMOUNTS
  useEffect(() => {
    return () => {
      if (cameraStream) {
        cameraStream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [cameraStream]);

  // OPEN CAMERA
  const startCamera = async (mode = facingMode) => {
    setError("");
    setResult(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        "Camera is unavailable. Use HTTPS or localhost and check your browser permissions."
      );
      return;
    }

    // Stop previous camera before switching
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      setCameraStream(null);
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: mode },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });

      setCameraStream(stream);
      setCameraActive(true);
      setFacingMode(mode);
      setImageData(null);
    } catch (err) {
      if (err.name === "NotAllowedError") {
        setError("Camera permission denied. Please allow camera access in your browser.");
      } else if (err.name === "NotFoundError") {
        setError("No camera was detected on this device.");
      } else {
        setError(err.message || "Unable to access camera.");
      }
    }
  };

  // SWITCH FRONT / REAR CAMERA
  const switchCamera = () => {
    const newMode =
      facingMode === "environment" ? "user" : "environment";

    startCamera(newMode);
  };

  // CAPTURE PHOTO FROM LIVE CAMERA
  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) {
      setError("Camera is not ready. Please try again.");
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video.videoWidth || !video.videoHeight) {
      setError("Please wait for the camera to load.");
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const context = canvas.getContext("2d");

    context.drawImage(
      video,
      0,
      0,
      canvas.width,
      canvas.height
    );

    const previewUrl = canvas.toDataURL("image/jpeg", 0.9);
    const base64 = previewUrl.split(",")[1];

    setImageData({
      base64,
      mimeType: "image/jpeg",
      previewUrl,
    });

    setResult(null);
    setError("");

    stopCamera();
  };

  // UPLOAD PHOTO
  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];

    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setError("Please select a valid image.");
      return;
    }

    setError("");
    setResult(null);
    stopCamera();

    try {
      const parsed = await fileToBase64(file);
      setImageData(parsed);
    } catch {
      setError("Unable to load the selected image.");
    }

    // Allow selecting the same image again
    e.target.value = "";
  };

  // RETAKE PHOTO
  const retakePhoto = () => {
    setImageData(null);
    setResult(null);
    setError("");
    startCamera();
  };

  // RUN AI SCAN
  const handleRunScan = async () => {
    if (!imageData) return;

    setScanning(true);
    setError("");
    setResult(null);

    try {
      const report = await analyzeSneakerWithGemini({
        base64: imageData.base64,
        mimeType: imageData.mimeType,
        expectedModel: expectedModel.trim(),
      });

      setResult(report);
    } catch (err) {
      setError(err.message || "Unable to scan sneaker.");
    } finally {
      setScanning(false);
    }
  };

  // CLOSE MODAL
  const closeScanner = () => {
    stopCamera();
    setIsOpen(false);
    setError("");
  };

  const verdictClass =
    result?.verdict === "AUTHENTIC"
      ? "authentic"
      : result?.verdict === "FAKE"
      ? "fake"
      : "inconclusive";

  return (
    <>
      {/* HEADER BUTTON */}
      <button
        type="button"
        className="ss-scanner-trigger"
        onClick={() => setIsOpen(true)}
      >
        <span>📷</span> AI Legit Check
      </button>

      {isOpen && (
        <div
          className="ss-scan-backdrop"
          onClick={closeScanner}
        >
          <div
            className="ss-scan-modal"
            onClick={(e) => e.stopPropagation()}
          >
            {/* HEADER */}
            <div className="ss-scan-header">
              <div className="ss-scan-title-group">
                <span className="ss-scan-badge-ai">
                  GEMINI VISION AI
                </span>
                <h3>Sneaker & Barcode Scanner</h3>
              </div>

              <button
                type="button"
                className="ss-scan-close"
                onClick={closeScanner}
              >
                ✕
              </button>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={handleFileChange}
            />

            <canvas ref={canvasRef} hidden />

            {/* LIVE CAMERA */}
            {cameraActive ? (
              <div className="ss-camera-container">
                <video
                  ref={videoRef}
                  className="ss-live-video"
                  autoPlay
                  playsInline
                  muted
                />

                <div className="ss-camera-overlay">
                  <div className="ss-camera-frame">
                    <span className="ss-frame-corner top-left" />
                    <span className="ss-frame-corner top-right" />
                    <span className="ss-frame-corner bottom-left" />
                    <span className="ss-frame-corner bottom-right" />

                    <div className="ss-camera-guide">
                      CENTER YOUR SNEAKER HERE
                    </div>
                  </div>
                </div>

                <div className="ss-camera-live-badge">
                  <span className="ss-live-dot" />
                  LIVE CAMERA
                </div>

                <div className="ss-camera-controls">
                  <button
                    type="button"
                    className="ss-camera-switch"
                    onClick={switchCamera}
                  >
                    🔄 Switch
                  </button>

                  <button
                    type="button"
                    className="ss-capture-btn"
                    onClick={capturePhoto}
                  >
                    <span className="ss-capture-inner" />
                  </button>

                  <button
                    type="button"
                    className="ss-camera-cancel"
                    onClick={stopCamera}
                  >
                    ✕ Close
                  </button>
                </div>
              </div>
            ) : imageData ? (
              /* CAPTURED PHOTO PREVIEW */
              <div className="ss-preview-wrap">
                <img
                  src={imageData.previewUrl}
                  alt="Captured sneaker"
                />

                {scanning && <div className="ss-scan-laser" />}

                {!scanning && (
                  <div className="ss-photo-actions">
                    <button
                      type="button"
                      className="ss-change-photo-btn"
                      onClick={() => {
                        setImageData(null);
                        setResult(null);
                        startCamera();
                      }}
                    >
                      📷 Retake
                    </button>

                    <button
                      type="button"
                      className="ss-change-photo-btn"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Upload Another
                    </button>
                  </div>
                )}
              </div>
            ) : (
              /* CAMERA / UPLOAD DROPZONE */
              <div className="ss-dropzone">
                <div className="ss-dropzone-icon">
                  📷
                </div>

                <div className="ss-dropzone-title">
                  Scan Your Sneakers
                </div>

                <div className="ss-dropzone-sub">
                  Use your camera for a live scan or upload a
                  sneaker photo. Capture the side profile,
                  stitching, size tag, or box barcode.
                </div>

                <div className="ss-start-options">
                  <button
                    type="button"
                    className="ss-open-camera-btn"
                    onClick={() => startCamera()}
                  >
                    <span>📸</span>
                    Open Camera
                  </button>

                  <button
                    type="button"
                    className="ss-upload-btn"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <span>🖼️</span>
                    Upload Photo
                  </button>
                </div>
              </div>
            )}

            {/* MODEL / SKU */}
            <div className="ss-scan-inputs">
              <label>
                Sneaker Model or SKU (Optional)
              </label>

              <input
                type="text"
                value={expectedModel}
                onChange={(e) => setExpectedModel(e.target.value)}
                placeholder="e.g., Nike Air Max 1 Crimson or DZ4549-100"
              />
            </div>

            {/* ERROR */}
            {error && (
              <div className="ss-scanner-error">
                {error}
              </div>
            )}

            {/* SCAN BUTTON */}
            <button
              type="button"
              className="ss-run-scan-btn"
              disabled={!imageData || scanning || cameraActive}
              onClick={handleRunScan}
            >
              {scanning
                ? "Scanning Shoe Details..."
                : "Scan Shoe for Authenticity"}
            </button>

            {/* RESULTS */}
            {result && (
              <div className="ss-scan-result">
                <div className={`ss-verdict-banner ${verdictClass}`}>
                  <span className="ss-verdict-label">
                    {result.verdict === "AUTHENTIC" &&
                      "✓ LIKELY AUTHENTIC"}

                    {result.verdict === "FAKE" &&
                      "✕ POSSIBLE REPLICA"}

                    {result.verdict === "INCONCLUSIVE" &&
                      "⚠ INCONCLUSIVE"}
                  </span>

                  <span className="ss-confidence-pill">
                    {result.confidence}% Confidence
                  </span>
                </div>

                <div className="ss-detected-meta">
                  <div className="ss-meta-box">
                    <span>Detected Sneaker</span>
                    <strong>{result.detectedModel}</strong>
                  </div>

                  <div className="ss-meta-box">
                    <span>Barcode / SKU Tag</span>
                    <strong>{result.extractedBarcodeOrSku}</strong>
                  </div>
                </div>

                <div className="ss-checklist">
                  {result.checks?.map((item, idx) => (
                    <div className="ss-check-item" key={idx}>
                      <div className="ss-check-item-head">
                        <span>{item.area}</span>

                        <span
                          className={
                            item.passed
                              ? "ss-status-pass"
                              : "ss-status-flag"
                          }
                        >
                          {item.passed ? "✓ Passed" : "✕ Flagged"}
                        </span>
                      </div>

                      <p>{item.detail}</p>
                    </div>
                  ))}
                </div>

                <div className="ss-demo-note">
                  AI visual assessment only. This is not
                  guaranteed proof of authenticity. Professional
                  verification may still be necessary.
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
