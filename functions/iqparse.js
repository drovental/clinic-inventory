// iqparse.js — parse an Alma IQ skin-analysis report PDF (iPad export)
// Returns patient details + the labelled images (as JPEG buffers).
// Pure JS (pdfjs-dist legacy build + jpeg-js) so it runs inside Cloud Functions.
const pdfjs = require("pdfjs-dist/legacy/build/pdf.mjs");
const jpeg = require("jpeg-js");

const VIEW_LABELS = { "": "חזית", L40: "שמאל 40°", L90: "שמאל 90°", R40: "ימין 40°", R90: "ימין 90°" };
const MODE_LABELS = {
  daylight: "אור יום", cp: "CP", pp: "PP", redness: "אדמומיות", pigmentation: "פיגמנטציה",
  texture: "מרקם", light360: "360 LIGHT", grey360: "360 GREY", wood: "מנורת WOOD", uv: "TRUE UV",
};

function normalizeLabel(raw) {
  // Labels come out of the PDF with bidi marks and odd ordering, e.g. "‪ - L40‬אור יום", "WOOD ‫ מנורת‬- R90"
  const t = raw.replace(/[‎‏‪-‮]/g, "").replace(/\s+/g, " ").trim();
  const view = (t.match(/\b([LR](?:40|90))\b/) || [])[1] || "";
  const u = t.toUpperCase();
  let mode = null;
  if (/אור יום/.test(t)) mode = "daylight";
  else if (/אדמומיות/.test(t)) mode = "redness";
  else if (/פיגמנטציה/.test(t)) mode = "pigmentation";
  else if (/מרקם/.test(t)) mode = "texture";
  else if (/WOOD/.test(u)) mode = "wood";
  else if (/TRUE UV|\bUV\b/.test(u)) mode = "uv";
  else if (/360 LIGHT|LIGHT 360/.test(u)) mode = "light360";
  else if (/360 GREY|GREY 360/.test(u)) mode = "grey360";
  else if (/\bCP\b/.test(u)) mode = "cp";
  else if (/\bPP\b/.test(u)) mode = "pp";
  return mode ? { view, mode } : null;
}

function parsePatient(fullText) {
  const t = fullText.replace(/[‎‏‪-‮]/g, "");
  // The report has a clinic block and a patient block, both with name/email/phone; take the patient block.
  const patientBlock = (t.split(/פרטי המטופל/)[1] || t).split(/פרטי הפגישה/)[0];
  const name = (patientBlock.match(/שם\s*\n\s*([^\n]+)/) || [])[1]?.trim() || "";
  const email = (patientBlock.match(/([\w.+-]+@[\w-]+\.[\w.-]+)/) || [])[1] || "";
  const phone = (patientBlock.match(/(0\d{8,9}|972\d{8,9}|\+972\d{8,9})/) || [])[1] || "";
  const visitDate = (t.match(/(\d{1,2}\.\d{1,2}\.\d{4})/) || [])[1] || "";
  const visitTime = (t.match(/(\d{1,2}:\d{2})/) || [])[1] || "";
  return { name, email, phone, visitDate, visitTime };
}

async function parseIqReport(buffer) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false }).promise;
  let fullText = "";
  const images = [];
  const pagesSeen = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // text lines (for patient details) – group by y
    const items = tc.items.filter((i) => i.str && i.str.trim());
    // Rebuild visual lines: group by y, order right-to-left (Hebrew report)
    const rows = new Map();
    for (const i of items) { const y = Math.round(i.transform[5] / 3); if (!rows.has(y)) rows.set(y, []); rows.get(y).push(i); }
    const lines = [...rows.entries()].sort((a, b) => b[0] - a[0])
      .map(([, arr]) => arr.sort((a, b) => b.transform[4] - a.transform[4]).map((i) => i.str.trim()).join(" "));
    fullText += lines.join("\n") + "\n";

    // label candidates with positions
    const labels = items.map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width, str: i.str }));

    const ops = await page.getOperatorList();
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const mul = (a, b) => [
      a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
    ];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], args = ops.argsArray[i];
      if (fn === pdfjs.OPS.save) stack.push(ctm);
      else if (fn === pdfjs.OPS.restore) ctm = stack.pop() || ctm;
      else if (fn === pdfjs.OPS.transform) ctm = mul(ctm, args);
      else if (fn === pdfjs.OPS.paintImageXObject) {
        const name = args[0];
        // Image XObjects are cached per first page they appear on ("img_p1_8" lives in page 1's objs)
        let img = null;
        for (const pg of [page, ...pagesSeen]) {
          try { if (pg.objs.has(name)) { img = pg.objs.get(name); break; } } catch {}
          try { if (!img && pg.commonObjs.has(name)) { img = pg.commonObjs.get(name); break; } } catch {}
        }
        if (!img) {
          const store = name.startsWith("g_") ? page.commonObjs : page.objs; // "g_" = global image cache (shared across pages)
          try { img = await Promise.race([new Promise((res) => store.get(name, res)), new Promise((r) => setTimeout(() => r(null), 5000))]); } catch {}
        }
        if (!img) continue;
        if (!img || img.width < 200 || img.height < 200) continue; // skip icons/logos
        const x = ctm[4], y = ctm[5], w = Math.abs(ctm[0]), h = Math.abs(ctm[3]);
        images.push({ page: p, name, x, y, w, h, img });
      }
    }
    // attach the nearest label that sits just above each image (within its column)
    for (const im of images.filter((i) => i.page === p)) {
      const cx = im.x + im.w / 2;
      const top = im.y + im.h;
      const cand = labels
        .filter((l) => l.y > top - 4 && l.y < top + 40 && l.x + l.w / 2 >= im.x - 4 && l.x + l.w / 2 <= im.x + im.w + 4)
        .sort((a, b) => b.x - a.x);
      const lbl = cand.map((c) => c.str).join(" ");
      im.label = lbl;
      im.parsed = normalizeLabel(lbl);
    }
    pagesSeen.unshift(page);
  }

  const patient = parsePatient(fullText);
  const out = [];
  const seen = new Set();
  for (const im of images) {
    if (!im.parsed) continue;
    const key = im.parsed.view + "|" + im.parsed.mode;
    if (seen.has(key)) continue;
    seen.add(key);
    const { width, height, data, kind } = im.img;
    // pdfjs gives RGB (kind 2) or RGBA (kind 3) or grayscale (kind 1)
    const rgba = Buffer.alloc(width * height * 4);
    if (kind === 3) rgba.set(data);
    else if (kind === 2) for (let i = 0, j = 0; i < data.length; i += 3, j += 4) { rgba[j] = data[i]; rgba[j + 1] = data[i + 1]; rgba[j + 2] = data[i + 2]; rgba[j + 3] = 255; }
    else for (let i = 0, j = 0; i < data.length; i++, j += 4) { rgba[j] = rgba[j + 1] = rgba[j + 2] = data[i]; rgba[j + 3] = 255; }
    const jpg = jpeg.encode({ data: rgba, width, height }, 88).data;
    out.push({
      view: im.parsed.view, mode: im.parsed.mode,
      viewLabel: VIEW_LABELS[im.parsed.view] || im.parsed.view,
      modeLabel: MODE_LABELS[im.parsed.mode] || im.parsed.mode,
      width, height, jpeg: jpg, page: im.page,
    });
  }
  return { patient, images: out, pages: doc.numPages };
}

module.exports = { parseIqReport, VIEW_LABELS, MODE_LABELS };
