/**
 * Receipt scanning — required item 1's "upload a photo of a bill or receipt,
 * read the amount, date and shop name".
 *
 * THE REVIEW GATE IS ARCHITECTURAL, NOT A UI CHOICE.
 * This endpoint reads an image and returns a DRAFT. It has no access to the
 * expense collection and cannot write a row. The only way a scanned receipt
 * becomes an expense is a subsequent POST /expenses carrying values the user
 * submitted from the review form.
 *
 * That is deliberate. The brief requires the user to be able to "correct any
 * field before saving", and a gate enforced only by the frontend is one refactor
 * away from being bypassed. Enforced by the shape of the API, it cannot be.
 */
import { Router } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";

import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { AppError } from "../../shared/errors/app-error.js";
import { activeProvider, getOcr } from "../../shared/ocr/index.js";
import { EMPTY_EXTRACTION } from "../../shared/ocr/types.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (!ACCEPTED.has(file.mimetype)) {
      callback(new AppError(415, "UNSUPPORTED_MEDIA", "Upload a JPEG, PNG or WebP photo."));
      return;
    }
    callback(null, true);
  },
});

/**
 * A vision call costs real money and takes seconds. Without a cap, one loop in a
 * client — or one person holding down a button — runs up a bill and starves
 * every other user of the single Render instance.
 */
const scanLimiter = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: "RATE_LIMITED", message: "Too many scans. Wait a minute and try again." },
  },
});

export const receiptRouter = Router();

receiptRouter.use(authenticate, attachContext);

receiptRouter.post(
  "/scan",
  // Gated before the rate limiter: a role that may not scan should be told so
  // immediately rather than having its request counted against a quota it will
  // never spend.
  requirePermission("receipts.scan"),
  scanLimiter,
  upload.single("image"),
  handle(async (request, response) => {
    if (!request.file) {
      throw new AppError(400, "NO_IMAGE", "Attach a photo of the receipt.");
    }

    const ocr = await getOcr();

    // No provider configured is a degraded mode, not a failure: the client shows
    // the manual form with a note, and required item 1 is still satisfied by
    // hand entry. Returning 200 with a stated reason keeps that path simple.
    if (!ocr) {
      ok(response, {
        provider: "none",
        extraction: {
          ...EMPTY_EXTRACTION,
          error: "Receipt reading is not configured on this server. Enter the details by hand.",
        },
      });
      return;
    }

    const extraction = await ocr.extract({
      base64: request.file.buffer.toString("base64"),
      mediaType: request.file.mimetype,
    });

    // The draft, and nothing else. Nothing has been written.
    ok(response, { provider: activeProvider(), extraction, review_required: true });
  }),
);
