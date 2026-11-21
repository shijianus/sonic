# EpoCanvas Sonic audio archives

Every ordinary Sonic download ends in `.ecs`. The suffix before it indicates the
archive tier: `.ecs1.ecs` for the original/source tier, `.ecs2.ecs` for
the high tier, and `.ecs3.ecs` for standard. Sonic caps the selected tier at the quality it can establish from the downloaded audio.
An archive tier does not certify a studio master. The player inspects the decoded audio. Choosing Original
when exporting preserves the downloaded audio bytes exactly.

## Deployment

Configure an independent 32-byte key as 64 hex characters in SONIC_ECS_MASTER_KEY
on Pages and on the Engine. Generate it with `openssl rand -hex 32`. Back up the
secret outside the source repository. Set SONIC_ECS_DOWNLOAD_SOURCES and
SONIC_ECS_EXPORT_SOURCES separately, with comma-separated source IDs covered by
the applicable offline-copy and ordinary-file export rights. The latter also
requires the former. Explicit empty lists disable that capability. The absence of
these lists defaults to synthetic fixtures only, still subject to the existing
environment's content policy. Actual streaming rights alone do not enable either.
For one rotation, move the previous master to SONIC_ECS_MASTER_KEY_PREV before
setting the new current key. Older files require the corresponding old master
on first access from another browser. Reissue/repackage or retain a controlled
recovery procedure before retiring that previous key.

## Wire format and playback

An ECS v1 file is an RFC 7516 Compact JWE using dir and A256GCM via the jose
library. The protected header carries typ=application/vnd.epocanvas.sonic+jwe,
ecs=1 and a kid containing the server's opaque encrypted key ticket. The ticket
is sealed with the server master key, a fresh 96-bit nonce and format-specific
associated data. Inside the authenticated ciphertext, a big-endian 32-bit metadata
length precedes UTF-8 JSON and the original audio bytes. Title, artist, album,
source, source track ID and the archive tier are inside the ciphertext. Archive size
is limited to 64 MiB of audio. Track names are not needed by the key service.

The per-file content key is randomly generated on each issue. The browser stores
a non-extractable CryptoKey in the music IndexedDB for same-device offline playback.
A new browser contacts the originating deployment once to open its ticket.
Clearing all local data erases this key cache. Losing the server's applicable
master key prevents opening the archive on a fresh device. Playback of an already
cached offline file cannot be remotely revoked while the device is offline.
Opening the player itself offline also requires the app shell to be available.

The official ordinary-file export requests current account authorization from
POST /api/music/ecs on every invocation, including when the file is cached.
Guests can obtain ECS downloads and play them. Accounts can export original
bytes, or use the bundled MP3 worker at 128 or 320 kbps, from supported mono or
stereo inputs up to ten minutes. High export is available for ECS1/2 only, and refuses low-bitrate lossy inputs or sample rates below 32 kHz. Encoding never raises the sample rate above the source.
MP3 encoding is lossy and cannot restore information missing from the source.
This format provides encrypted distribution and authenticated official export.
A web client authorized to play audio receives decoded bytes. This design does
not provide hardware DRM or a tamper-proof claim about authorship.

References: https://www.rfc-editor.org/rfc/rfc7516 ,
https://github.com/panva/jose and https://github.com/shijinyu/lamejs .
