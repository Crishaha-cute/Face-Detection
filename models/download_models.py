"""Downloads the two OpenCV Zoo ONNX models into this folder."""
import os, urllib.request

BASE = "https://github.com/opencv/opencv_zoo/raw/main/models"
FILES = {
    "face_detection_yunet_2023mar.onnx": f"{BASE}/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "face_recognition_sface_2021dec.onnx": f"{BASE}/face_recognition_sface/face_recognition_sface_2021dec.onnx",
}
here = os.path.dirname(os.path.abspath(__file__))
for name, url in FILES.items():
    dest = os.path.join(here, name)
    if os.path.exists(dest) and os.path.getsize(dest) > 100_000:
        print("have", name); continue
    print("downloading", name)
    urllib.request.urlretrieve(url, dest)
print("done")
