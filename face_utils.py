import base64, math, os, threading
from dataclasses import dataclass

import cv2
import numpy as np

MODELS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
DETECTOR_PATH = os.path.join(MODELS, "face_detection_yunet_2023mar.onnx")
RECOGNIZER_PATH = os.path.join(MODELS, "face_recognition_sface_2021dec.onnx")

# Cosine similarity needed to count as the same person (OpenCV's suggested value for SFace).
MATCH_THRESHOLD = 0.363
MAX_WIDTH = 640

# Liveness tuning
STRAIGHT_MAX_DEG = 10      # first pose: head must be roughly level
YAW_MIN = 0.045            # rotating/turning head slightly left/right (fraction of eye distance)
TILT_MIN_DEG = 4.0         # or tilting head slightly
# Some webcam drivers send a mirrored picture, which swaps left and right. If the error message
# shows a NEGATIVE angle when you tilt toward the requested shoulder, set FLIP_TILT=1.
FLIP_TILT = os.environ.get("FLIP_TILT") == "1"
CLOSED_RATIO = 0.68        # eyes-closed contrast must drop below 68% of baseline open-eye contrast
POSE_ID_MIN = 0.20         # same-person sanity check on the tilt / eyes-closed frames


class FaceError(Exception):
    """A problem with the submitted image that the user can fix."""


@dataclass
class Analysis:
    emb: np.ndarray    # unit-length 128-d face print
    roll: float        # degrees; positive = head tilted toward the person's LEFT shoulder
    yaw: float         # positive = head turned toward person's LEFT, negative = RIGHT
    contrast: float    # mean grayscale std-dev around both eyes (falls when the eyes close)


class FaceEngine:
    def __init__(self):
        for p in (DETECTOR_PATH, RECOGNIZER_PATH):
            if not os.path.exists(p):
                raise RuntimeError("Model files missing. Run: python models/download_models.py")
        self.detector = cv2.FaceDetectorYN.create(DETECTOR_PATH, "", (320, 320), 0.8, 0.3, 5000)
        self.recognizer = cv2.FaceRecognizerSF.create(RECOGNIZER_PATH, "")
        self.lock = threading.Lock()  # OpenCV DNN objects are not thread-safe

    @staticmethod
    def decode(data_url: str) -> np.ndarray:
        try:
            raw = base64.b64decode(data_url.split(",", 1)[-1])
            img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        except Exception:
            img = None
        if img is None:
            raise FaceError("The image could not be read. Try again.")
        h, w = img.shape[:2]
        if w > MAX_WIDTH:
            img = cv2.resize(img, (MAX_WIDTH, int(h * MAX_WIDTH / w)))
        return img

    def analyze(self, data_url: str) -> Analysis:
        """Face print + head roll + head yaw + eye contrast for the face in the image."""
        img = self.decode(data_url)
        h, w = img.shape[:2]
        with self.lock:
            self.detector.setInputSize((w, h))
            _, faces = self.detector.detect(img)
            if faces is None or len(faces) == 0:
                raise FaceError("No face found. Face the camera in good light.")
            if len(faces) > 1:
                raise FaceError("More than one face in view. Only one person at a time.")
            face = faces[0]
            aligned = self.recognizer.alignCrop(img, face)
            feat = self.recognizer.feature(aligned).flatten().astype(np.float32)
        emb = feat / np.linalg.norm(feat)

        # landmarks: face[4:6] and face[6:8] are the two eyes
        a, b = sorted([face[4:6], face[6:8]], key=lambda p: p[0])  # a = left in image, b = right in image
        roll = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))

        # Calculate head yaw (horizontal rotation) based on nose tip position relative to eyes
        dx = b[0] - a[0]
        dy = b[1] - a[1]
        eye_dist = max(1.0, math.hypot(dx, dy))
        ux, uy = dx / eye_dist, dy / eye_dist
        proj = ((float(face[8]) - a[0]) * ux + (float(face[9]) - a[1]) * uy) / eye_dist
        yaw = float(proj - 0.5)

        if FLIP_TILT:
            roll = -roll
            yaw = -yaw

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        d = max(1.0, math.hypot(b[0] - a[0], b[1] - a[1]))
        rx = max(4, int(d * 0.16))
        ry = max(3, int(d * 0.09))
        vals = []
        for x, y in (a, b):
            x, y = int(round(x)), int(round(y))
            patch = gray[max(0, y - ry):y + ry, max(0, x - rx):x + rx]
            if patch.size:
                vals.append(float(patch.std()))
        return Analysis(emb, roll, yaw, float(np.mean(vals)) if vals else 0.0)

    def detect_landmarks(self, data_url: str):
        """Extracts face landmarks and bounding box for live accessory overlay."""
        img = self.decode(data_url)
        h, w = img.shape[:2]
        with self.lock:
            self.detector.setInputSize((w, h))
            _, faces = self.detector.detect(img)
            if faces is None or len(faces) == 0:
                return None
            face = faces[0]
            re = [float(face[4]), float(face[5])]
            le = [float(face[6]), float(face[7])]
            eye_a, eye_b = sorted([re, le], key=lambda p: p[0])
            rm = [float(face[10]), float(face[11])]
            lm = [float(face[12]), float(face[13])]
            mouth_a, mouth_b = sorted([rm, lm], key=lambda p: p[0])
            roll = math.degrees(math.atan2(eye_b[1] - eye_a[1], eye_b[0] - eye_a[0]))
            return {
                "box": [float(face[0]), float(face[1]), float(face[2]), float(face[3])],
                "eye_left": eye_a,
                "eye_right": eye_b,
                "nose": [float(face[8]), float(face[9])],
                "mouth_left": mouth_a,
                "mouth_right": mouth_b,
                "roll": roll,
                "w": w,
                "h": h
            }

    @staticmethod
    def average(embeddings) -> np.ndarray:
        m = np.mean(embeddings, axis=0)
        return (m / np.linalg.norm(m)).astype(np.float32)

    @staticmethod
    def similarity(a: np.ndarray, b: np.ndarray) -> float:
        return float(np.dot(a, b))


_engine = None
_engine_lock = threading.Lock()

def get_engine() -> FaceEngine:
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = FaceEngine()
        return _engine
