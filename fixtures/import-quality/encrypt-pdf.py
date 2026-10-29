"""Independent valid password-PDF fixture; only anonymous generated input.

Requires pypdf in a development Python runtime (no product dependency).
Reads a PDF on stdin and writes an encrypted PDF on stdout. Encryption may
vary bytes between runs; record each input digest rather than freezing it.
"""
import io
import sys

from pypdf import PdfReader, PdfWriter

source = PdfReader(io.BytesIO(sys.stdin.buffer.read()))
writer = PdfWriter()
writer.append(source)
writer.encrypt("synthetic-owned-password", algorithm="RC4-128")
buffer = io.BytesIO()
writer.write(buffer)
encrypted = buffer.getvalue()
check = PdfReader(io.BytesIO(encrypted))
assert check.is_encrypted
assert check.decrypt("incorrect-password") == 0
assert check.decrypt("synthetic-owned-password") != 0
assert len(check.pages) == len(source.pages)
sys.stdout.buffer.write(encrypted)
