"""Generate PNG or JPEG previews with the Windows system GDI+ codec."""
import ctypes
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


def encode_preview(path, width, height, max_width=720):
    """Resize a bounded image, preserving transparency."""
    if not width or not height or width * height > MAX_SOURCE_PIXELS:
        return None
    library = graphics_library()
    scale = min(1, max_width / width, 1600 / height)
    width, height = max(1, round(width * scale)), max(1, round(height * scale))
    with ExitStack() as cleanup:
        source, bitmap, graphics = c_void_p(), c_void_p(), c_void_p()
        checked(library.GdipLoadImageFromFile(str(path), byref(source)))
        cleanup.callback(library.GdipDisposeImage, source)
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
        source_width, source_height = c_uint(), c_uint()
        checked(library.GdipGetImageWidth(source, byref(source_width)))
        checked(library.GdipGetImageHeight(source, byref(source_height)))
        if source_width.value * source_height.value > MAX_SOURCE_PIXELS:
            return None
        checked(library.GdipDrawImageRectRectI(graphics, source, 0, 0, width, height, 0, 0,
                source_width, source_height, 2, attributes, None, None))
        encoder = preview_encoder(library, bitmap, width, height)
        with TemporaryDirectory() as directory:
            output = Path(directory) / "preview"
            checked(library.GdipSaveImageToFile(bitmap, str(output), encoder, None))
            return output.read_bytes()


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
