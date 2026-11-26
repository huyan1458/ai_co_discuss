"""Generate PNG or JPEG previews with the Windows system GDI+ codec."""
import ctypes
import os
import subprocess
from contextlib import ExitStack
from functools import lru_cache
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import UUID

from ctypes import byref, c_int, c_uint, c_void_p, c_size_t, Structure


class StartupInput(Structure):
    _fields_ = [("version", c_uint), ("callback", c_void_p), ("no_thread", c_int), ("no_codec", c_int)]


class BitmapData(Structure):
    _fields_ = [("width", c_uint), ("height", c_uint), ("stride", c_int), ("format", c_int),
                ("pixels", c_void_p), ("reserved", c_size_t)]


ARGB32 = 0x26200A
PNG_ENCODER = UUID("557cf406-1a04-11d3-9a73-0000f81ef32e").bytes_le
JPEG_ENCODER = UUID("557cf401-1a04-11d3-9a73-0000f81ef32e").bytes_le
MAX_SOURCE_PIXELS = 24_000_000


def checked(status):
    """Raise when the native image operation fails."""
    if status:
        raise ValueError(f"GDI+ status {status}")


@lru_cache(maxsize=1)
def graphics_library():
    """Initialize the system codec for the process lifetime."""
    library = ctypes.WinDLL("gdiplus", winmode=0x800)
    token = c_size_t()
    checked(library.GdiplusStartup(byref(token), byref(StartupInput(1)), None))
    return library


def encode_preview(path, width, height, max_width=720, project=False):
    """Resize a bounded image, preserving transparency."""
    if not width or not height or width * height > MAX_SOURCE_PIXELS:
        return None
    library = graphics_library()
    max_height = max_width if project else 1600
    with ExitStack() as cleanup:
        source, bitmap, graphics = c_void_p(), c_void_p(), c_void_p()
        checked(library.GdipLoadImageFromFile(str(path), byref(source)))
        cleanup.callback(library.GdipDisposeImage, source)
        source_width, source_height = c_uint(), c_uint()
        checked(library.GdipGetImageWidth(source, byref(source_width)))
        checked(library.GdipGetImageHeight(source, byref(source_height)))
        if source_width.value * source_height.value > MAX_SOURCE_PIXELS:
            return None
        # JPEG header dimensions may already include EXIF rotation. Draw in native pixel space first.
        scale = min(1, max_width / source_width.value, max_height / source_height.value)
        width = max(1, round(source_width.value * scale))
        height = max(1, round(source_height.value * scale))
        checked(library.GdipCreateBitmapFromScan0(width, height, 0, ARGB32, None, byref(bitmap)))
        cleanup.callback(library.GdipDisposeImage, bitmap)
        checked(library.GdipGetImageGraphicsContext(bitmap, byref(graphics)))
        cleanup.callback(library.GdipDeleteGraphics, graphics)
        checked(library.GdipSetInterpolationMode(graphics, 7))
        # TileFlipXY extends the edge pixels during bicubic filtering.
        attributes = c_void_p()
        checked(library.GdipCreateImageAttributes(byref(attributes)))
        cleanup.callback(library.GdipDisposeImageAttributes, attributes)
        checked(library.GdipSetImageAttributesWrapMode(attributes, 3, 0, 0))
        checked(library.GdipDrawImageRectRectI(graphics, source, 0, 0, width, height, 0, 0,
                source_width, source_height, 2, attributes, None, None))
        encoder = preview_encoder(library, bitmap, width, height)
        if project:
            apply_image_orientation(library, source, bitmap)
        with TemporaryDirectory() as directory:
            output = Path(directory) / "preview"
            checked(library.GdipSaveImageToFile(bitmap, str(output), encoder, None))
            return output.read_bytes()


def apply_image_orientation(library, source, bitmap):
    """Apply the source EXIF orientation to the rendered bitmap before exporting without metadata."""
    tag = 0x112
    size = c_uint()
    if library.GdipGetPropertyItemSize(source, tag, byref(size)) or not size.value:
        return
    class PropertyItem(Structure):
        _fields_ = [("tag", c_uint), ("length", c_uint), ("type", ctypes.c_ushort), ("value", c_void_p)]
    buffer = ctypes.create_string_buffer(size.value)
    if library.GdipGetPropertyItem(source, tag, size, buffer):
        return
    item = PropertyItem.from_buffer(buffer)
    if item.type == 3 and item.length == 2 and item.value:
        orientation = ctypes.c_ushort.from_address(item.value).value
        rotation = {2: 4, 3: 2, 4: 6, 5: 5, 6: 1, 7: 7, 8: 3}.get(orientation)
        if rotation is not None:
            checked(library.GdipImageRotateFlip(bitmap, rotation))


def preview_encoder(library, bitmap, width, height):
    """Keep transparency in PNG, otherwise use the system JPEG encoder."""
    pixels = BitmapData()
    checked(library.GdipBitmapLockBits(bitmap, None, 1, ARGB32, byref(pixels)))
    try:
        if pixels.stride == width * 4:
            alpha = ctypes.string_at(pixels.pixels, pixels.stride * height)[3::4]
            if alpha.count(255) == len(alpha):
                return JPEG_ENCODER
        return PNG_ENCODER
    finally:
        library.GdipBitmapUnlockBits(bitmap, byref(pixels))

def decode_system_webp(path, output):
    """Use the Windows Imaging Component WebP decoder if registered, keeping transparency."""
    command = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
$decoder = [Windows.Media.Imaging.BitmapDecoder]::Create(
    [Uri]::new($env:CODISCUSS_WEBP_INPUT), 'PreservePixelFormat', 'OnLoad')
$frame = $decoder.Frames[0]
$encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new()
$encoder.Frames.Add($frame)
$stream = [IO.File]::Create($env:CODISCUSS_WEBP_OUTPUT)
try { $encoder.Save($stream) } finally { $stream.Dispose() }
"""
    powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-Command", command],
                   env={**os.environ, "CODISCUSS_WEBP_INPUT": str(path), "CODISCUSS_WEBP_OUTPUT": str(output)},
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=8,
                   creationflags=subprocess.CREATE_NO_WINDOW)


if __name__ == "__main__":
    # The runner supplies an already opened project file as stdin. Never resolve a project-supplied module.
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from backend.server import image_size

    with TemporaryDirectory() as directory:
        path = Path(directory) / "source"
        remaining = os.fstat(sys.stdin.fileno()).st_size
        if not 0 < remaining <= 64 * 1024 * 1024:
            sys.exit(0)
        with path.open("wb") as out:
            while remaining:
                chunk = sys.stdin.buffer.read(min(remaining, 1024 * 1024))
                if not chunk:
                    sys.exit(0)
                out.write(chunk)
                remaining -= len(chunk)
        with path.open("rb") as source:
            width, height = image_size(source)
            source.seek(0)
            webp = source.read(12)[8:12] == b"WEBP"
        if not width or not height or width * height > MAX_SOURCE_PIXELS:
            sys.exit(0)
        if webp:
            decoded = Path(directory) / "decoded.png"
            decode_system_webp(path, decoded)
            path = decoded
        # The longest side asked for: 1440 for the preview, smaller for the file page's thumbnails.
        side = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 1440
        result = encode_preview(path, width, height, max(64, min(side, 1440)), project=True)
        if result and len(result) < os.fstat(sys.stdin.fileno()).st_size:
            sys.stdout.buffer.write(result)
