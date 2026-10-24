# 0031. Images in the chat: pasted screenshots in, existing image files out

## Status

Accepted, 2026-10-24.

## Context

The user wants to show Pi a screenshot from the web app, either pasted on a desktop or picked on a phone. Pi should
also be able to show the user an image that already exists, such as a browser screenshot taken to prove how a page
looks. The model already sees images from tool results (`read`, `browser_screenshot`), but the chat showed none of
them. Images here are always screenshots or existing files: Persistence does not generate images.

## Decision

- **User → Pi.** The protocol `send` op takes an optional `images: {mimeType, data}[]` (base64), and the text may
  then be empty. The server (`src/server/hub.ts`, `src/protocol/images.ts`) accepts at most 4 images per message.
  Each must be PNG, JPEG, GIF or WebP, its magic bytes must match its `mimeType`, and it may be at most
  `IMAGE_LIMITS.sendBytes` (900 KiB of base64), so four images fit in one 4 MiB frame. Anything else gets
  `bad_request`. The session adds them to the user message (`userInput`, `src/runtime/models.ts`).
- **A model without images refuses.** When Pi's model does not list `image` as an input,
  `send` fails with a clear error and nothing is admitted. Without this check, pi-ai would quietly replace the images
  with a text note, and the model would answer about images it never saw.
- **claude-cli takes images.** Its requests feed stdin with `--input-format stream-json`: one user message line
  whose content is the latest user message's images, as Anthropic base64 image blocks, then the prompt text
  (`renderInput`, `src/providers/claude-cli.ts`). Images in earlier turns stay `[image: <type>, not shown]` in the
  folded transcript. Verified by hand on CLI 2.1.304: a solid green PNG sent this way was answered "green".
- **The web composer** has an attach button (`<input type="file" accept="image/*" multiple>`, which opens the photo
  picker on a phone) and also accepts paste and drop. Each attached image shows as a thumbnail with a remove button.
  An image that is too large, has too many pixels or uses another type (HEIC) is drawn again on a canvas as JPEG,
  scaled to at most 2000 px (`src/web/attach.ts`). A failed send puts its images back in the composer. A reload
  keeps only the text.
- **Pi → user: `show_image(path)`** (`src/tools/show-image.ts`, extension `show-image`; both names are persisted).
  It reads an existing file through the tools' guarded environment, so protected folders stay hidden. The file must
  be PNG, JPEG, GIF or WebP by its magic bytes, and at most `IMAGE_LIMITS.fileBytes` (2.25 MiB). The tool returns
  the image as a result block, so the model sees it too. It is on and off with the coding tools, and it refuses on
  a remote machine (`localOnly`). It cannot create or change an image.
- **The chat shows images.** `ChatItem` user and tool items gain an optional `images`. The feed takes them from the
  message blocks, and the web app shows them as thumbnails that enlarge on tap in a full-screen viewer. Images from
  `show_image` appear inline under the tool line. Images from other tools (a screenshot the model looked at) appear
  inside the tool's fold. On the wire, an image larger than `IMAGE_LIMITS.wireBytes` (3 MiB of base64, such as a
  huge full-page screenshot) is sent without its data, and the client shows a placeholder. The CSP allows `data:`
  for `img-src` only, and the images arrive inside protocol messages, never from another origin. The terminal
  shows a `[image]` marker instead.
- **Storage.** The images are stored with the message in pi-durable's entries (the database), as tool results
  always were. The memory log keeps text only and writes `[image]` (memory.md item 8). The images go to the model
  with the run's message only, even when a huge message goes as its tail.

## Consequences

- The protocol stays at version 3: `images` is an optional field.
- Each image adds up to 900 KiB to the database and to every snapshot of the feed that holds it. The feed keeps only
  its newest 200 items, so old images drop out of what clients receive.
- Older clients ignore `images`. A user message with only images shows as an empty bubble there.
