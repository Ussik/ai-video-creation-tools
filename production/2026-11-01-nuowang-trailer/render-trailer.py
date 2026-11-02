#!/usr/bin/env python3
"""Render only this independent production's new files; never write to Studio's DB.

Run with the bundled Python runtime (Pillow and NumPy are required):
  python render-trailer.py --prepare-only
  python render-trailer.py
"""
from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
FFMPEG = REPO / "backend/node_modules/ffmpeg-static/ffmpeg"
WIDTH, HEIGHT, FPS, DURATION = 1280, 720, 24, 90.0
TITLE = ROOT / "edit/title-card.png"
OUTPUT = ROOT / "傩王_90秒预告_鼓起人间.mp4"
SCORE = ROOT / "audio/nuowang_original_ritual_cue_90s.wav"
FONT_SONG = "/System/Library/Fonts/Supplemental/Songti.ttc"
FONT_SANS = "/System/Library/Fonts/STHeiti Medium.ttc"


def run(args, *, log=None):
    result = subprocess.run([str(FFMPEG), "-hide_banner", "-nostdin", *map(str, args)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if log:
        Path(log).write_text(result.stderr, encoding="utf-8")
    if result.returncode:
        raise RuntimeError(result.stderr[-12000:])
    return result


def probe(path):
    # The bundled FFmpeg build can inspect media even without a separate ffprobe.
    result = subprocess.run([str(FFMPEG), "-hide_banner", "-i", str(path)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    txt = result.stderr
    match = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", txt)
    if not match:
        raise ValueError(f"Cannot inspect media duration: {path}\n{txt}")
    h, m, s = map(float, match.groups())
    video = re.search(r"Video: ([^\n]+)", txt)
    dims = re.search(r"\b(\d{2,5})x(\d{2,5})\b", video.group(1)) if video else None
    return {"duration": h * 3600 + m * 60 + s, "audio": "Audio:" in txt,
            "width": int(dims.group(1)) if dims else None,
            "height": int(dims.group(2)) if dims else None, "details": txt}


def tracked_width(draw, text, font, tracking):
    return sum(draw.textlength(char, font=font) for char in text) + tracking * max(0, len(text) - 1)


def tracked(draw, text, center_x, top, font, fill, tracking=0):
    x = center_x - tracked_width(draw, text, font, tracking) / 2
    for char in text:
        box = draw.textbbox((0, 0), char, font=font)
        draw.text((round(x), top - box[1]), char, font=font, fill=fill)
        x += draw.textlength(char, font=font) + tracking


def make_title():
    """Original typography, controlled grain and a restrained crimson ritual axis."""
    TITLE.parent.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(20261101)
    yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH]
    center = np.exp(-(((xx - 640) / 560) ** 2 + ((yy - 350) / 330) ** 2))
    grain = rng.normal(0, .8, (HEIGHT, WIDTH))
    rgb = np.stack([6 + center * 6 + grain, 9 + center * 6 + grain,
                    11 + center * 6 + grain], axis=-1).clip(0, 255).astype(np.uint8)
    image = Image.fromarray(rgb, "RGB").convert("RGBA")
    # The line alludes to the mask's vermilion marking without imitating a real ritual emblem.
    glow = Image.new("RGBA", image.size)
    g = ImageDraw.Draw(glow)
    g.line([(640, 98), (640, 572)], fill=(130, 24, 19, 115), width=5)
    g.line([(344, 405), (936, 405)], fill=(115, 22, 17, 90), width=2)
    image = Image.alpha_composite(image, glow.filter(ImageFilter.GaussianBlur(19)))
    d = ImageDraw.Draw(image)
    d.line([(640, 109), (640, 566)], fill=(149, 43, 31, 125), width=1)
    d.line([(377, 405), (903, 405)], fill=(145, 47, 32, 135), width=1)
    d.line([(640, 109), (628, 121)], fill=(160, 45, 30, 150), width=1)
    d.line([(640, 109), (652, 121)], fill=(160, 45, 30, 150), width=1)
    eyebrow = ImageFont.truetype(FONT_SONG, 22, index=6)
    tracked(d, "一甲子 · 万灵同鼓", 640, 154, eyebrow, (159, 141, 116, 255), 9)

    mask = Image.new("L", image.size)
    md = ImageDraw.Draw(mask)
    main = ImageFont.truetype(FONT_SONG, 224, index=0)
    tracked(md, "傩王", 640, 238, main, 255, 30)
    title_y = np.clip((yy - 236) / 217, 0, 1)
    light = 1 - title_y
    title_rgb = np.stack([205 + light * 36, 180 + light * 48,
                          134 + light * 72], axis=-1)
    # Barely visible pigment variation keeps the title from looking like flat UI text.
    title_rgb += rng.normal(0, 1.25, (HEIGHT, WIDTH, 1))
    pigment = Image.fromarray(title_rgb.clip(0, 255).astype(np.uint8), "RGB")
    image.paste(pigment, (0, 0), mask)
    d = ImageDraw.Draw(image)
    sub = ImageFont.truetype(FONT_SONG, 34, index=1)
    tracked(d, "鼓起人间", 640, 490, sub, (193, 169, 130, 255), 14)
    tagline = ImageFont.truetype(FONT_SONG, 27, index=6)
    tracked(d, "师兄，我想带你回家。", 640, 577, tagline, (183, 179, 168, 255), 2)
    image.convert("RGB").save(TITLE)
    return str(TITLE)


def ass_time(seconds):
    centis = round(seconds * 100)
    h, remainder = divmod(centis, 360000)
    m, remainder = divmod(remainder, 6000)
    s, cs = divmod(remainder, 100)
    return f"{h}:{m:02}:{s:02}.{cs:02}"


def write_captions(lines, infos):
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Narration,Heiti SC,33,&H00F3F1EB,&H00F3F1EB,&H00100D0B,&H90000000,0,0,0,0,100,100,1,0,1,2.2,0.8,2,86,86,51,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events, srt, cues = [], [], []
    for index, (line, info) in enumerate(zip(lines, infos)):
        start = float(line["at"])
        stop = min(start + info["duration"] + .18, 83.75,
                   float(lines[index + 1]["at"]) - .2 if index + 1 < len(lines) else 83.75)
        text = line["text"].replace("\n", r"\N")
        # Caption appears with the narration, then leaves picture breathing room.
        events.append(f"Dialogue: 0,{ass_time(start)},{ass_time(stop)},Narration,,0,0,0,,{{\\fad(100,150)}}{text}")
        def stamp(t):
            milliseconds = round(t * 1000)
            h, rem = divmod(milliseconds, 3600000)
            m, rem = divmod(rem, 60000)
            s, ms = divmod(rem, 1000)
            return f"{h:02}:{m:02}:{s:02},{ms:03}"
        srt.append(f"{index+1}\n{stamp(start)} --> {stamp(stop)}\n{line['text']}\n")
        cues.append({"start": start, "end": stop, "text": line["text"],
                     "speech_file": line["localPath"], "speech_duration": info["duration"]})
    ass = ROOT / "edit/narration.ass"
    ass.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
    (ROOT / "傩王_90秒预告_鼓起人间.srt").write_text("\n".join(srt), encoding="utf-8")
    return ass, cues


def filter_path(path):
    # FFmpeg's filter parser, separate from shell quoting (subprocess never uses a shell).
    return str(path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "'\\''")


def render(state):
    clips = sorted(state.get("clips", []), key=lambda c: c["key"])
    if len(clips) != 6:
        raise ValueError(f"Need exactly six clips, found {len(clips)}")
    lines = sorted(state["speech"]["lines"], key=lambda line: float(line["at"]))
    missing = [str(c.get("localPath", f"clip {c['key']} pending")) for c in clips
               if not c.get("localPath") or not Path(c["localPath"]).is_file()]
    missing += [str(l.get("localPath", f"speech {l['key']} pending")) for l in lines
                if not l.get("localPath") or not Path(l["localPath"]).is_file()]
    if not SCORE.is_file():
        missing.append(str(SCORE))
    if missing:
        raise FileNotFoundError("Render waits for these new production files:\n" + "\n".join(missing))
    infos = [probe(c["localPath"]) for c in clips]
    speech_infos = [probe(l["localPath"]) for l in lines]
    for index, info in enumerate(infos):
        needed = 15 if index < 5 else 9
        if info["duration"] < needed - .08:
            raise ValueError(f"Clip {index+1} has only {info['duration']} seconds; need {needed}")
    ass, cues = write_captions(lines, speech_infos)
    args = ["-y", "-filter_complex_threads", "2"]
    for clip in clips:
        args += ["-i", clip["localPath"]]
    args += ["-loop", "1", "-framerate", FPS, "-t", 6, "-i", TITLE, "-i", SCORE]
    for line in lines:
        args += ["-i", line["localPath"]]
    f = []
    for i, info in enumerate(infos):
        length = 15 if i < 5 else 9
        f.append(f"[{i}:v]trim=start=0:duration={length},setpts=PTS-STARTPTS,"
                 f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease,"
                 f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0x080c10,setsar=1,"
                 f"fps={FPS},format=yuv420p[v{i}]")
        if info["audio"]:
            f.append(f"[{i}:a]atrim=start=0:duration={length},asetpts=PTS-STARTPTS,"
                     f"aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                     f"apad=whole_dur={length},atrim=duration={length},"
                     f"afade=t=in:st=0:d=0.015,afade=t=out:st={length-.025}:d=0.025[a{i}]")
        else:
            f.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={length},"
                     f"asetpts=PTS-STARTPTS[a{i}]")
    f.append("[6:v]trim=duration=6,setpts=PTS-STARTPTS,format=yuv420p,"
             "fade=t=in:st=0:d=0.18,fade=t=out:st=5.35:d=0.65[title]")
    f.append("anullsrc=r=48000:cl=stereo,atrim=duration=6,asetpts=PTS-STARTPTS[titlea]")
    f.append("".join(f"[v{i}]" for i in range(6)) + "[title]concat=n=7:v=1:a=0[picture]")
    f.append("".join(f"[a{i}]" for i in range(6)) + "[titlea]concat=n=7:v=0:a=1,volume=0.55[source]")
    f.append(f"[picture]ass=filename='{filter_path(ass)}'[video]")
    for i, (line, info) in enumerate(zip(lines, speech_infos)):
        delay = round(float(line["at"]) * 1000)
        f.append(f"[{8+i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                 f"highpass=f=65,lowpass=f=12500,loudnorm=I=-19:TP=-2:LRA=8,"
                 f"volume=1.25,afade=t=in:st=0:d=0.015,"
                 f"afade=t=out:st={max(0,info['duration']-.045):.4f}:d=0.045,"
                 f"adelay={delay}|{delay},apad=whole_dur=90,atrim=duration=90[voice{i}]")
    f.append("".join(f"[voice{i}]" for i in range(len(lines))) +
             f"amix=inputs={len(lines)}:normalize=0:dropout_transition=0,asplit=2[narrator][duck]")
    f.append("[7:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
             "atrim=duration=90,asetpts=PTS-STARTPTS,volume=1.0[music]")
    f.append("[music][duck]sidechaincompress=threshold=0.035:ratio=4:attack=75:release=650:"
             "makeup=1:link=average:level_sc=1[score]")
    f.append("[source][score][narrator]amix=inputs=3:normalize=0:dropout_transition=0,"
             "atrim=duration=90,afade=t=out:st=89.5:d=0.5,"
             "loudnorm=I=-16:TP=-1.5:LRA=9,aresample=48000[audio]")
    graph = ";\n".join(f)
    graph_file = ROOT / "edit/render-filter.txt"
    graph_file.write_text(graph, encoding="utf-8")
    args += ["-filter_complex_script", graph_file, "-map", "[video]", "-map", "[audio]",
             "-t", "90", "-r", FPS, "-c:v", "libx264", "-preset", "medium", "-crf", "18",
             "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
             "-movflags", "+faststart", "-metadata", "title=傩王｜90秒预告·鼓起人间",
             "-metadata", "comment=独立预告画布制作；依项目已有设定；无剧透终局。", OUTPUT]
    print("Rendering independent 90-second trailer...", flush=True)
    run(args, log=ROOT / "edit/render.log")
    result = probe(OUTPUT)
    if abs(result["duration"] - 90) > .06 or (result["width"], result["height"]) != (1280, 720):
        raise ValueError(f"Unexpected output dimensions or duration: {result}")
    # Full decode, frame count and loudness inspection run on the actual encoded delivery file.
    decode = run(["-v", "error", "-i", OUTPUT, "-map", "0:v:0", "-map", "0:a:0",
                  "-f", "null", "-"], log=ROOT / "edit/decode-verification.log")
    levels = run(["-i", OUTPUT, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"],
                 log=ROOT / "edit/loudness-verification.log")
    summary = levels.stderr[levels.stderr.rfind("Summary:"):]
    manifest = {"file": str(OUTPUT), "duration_seconds": result["duration"],
                "width": result["width"], "height": result["height"], "fps": FPS,
                "size_bytes": OUTPUT.stat().st_size, "full_decode_passed": decode.returncode == 0,
                "narration_cues": cues, "title_start": 84, "title_duration": 6,
                "original_sound_gain": .55, "score_gain_before_duck": 1.0,
                "speech_gain_after_normalization": 1.25, "loudness_verification": summary,
                "source_clip_files": [c["localPath"] for c in clips],
                "source_clip_durations": [i["duration"] for i in infos],
                "edits": "clips01–05 full15s; clip06 first9s; independent title84–90s"}
    (ROOT / "edit/render-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2),
                                                     encoding="utf-8")
    print(json.dumps({k: manifest[k] for k in ["file", "duration_seconds", "width", "height",
                                              "size_bytes", "full_decode_passed"]},
                     ensure_ascii=False, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-only", action="store_true", help="Build title/captions; do not render clips")
    parser.add_argument("--title-preview", action="store_true", help="Also make a six-second silent title preview")
    args = parser.parse_args()
    make_title()
    state = json.loads((ROOT / "state.json").read_text(encoding="utf-8"))
    speech = sorted(state.get("speech", {}).get("lines", []), key=lambda line: float(line["at"]))
    if speech and all(line.get("localPath") and Path(line["localPath"]).is_file() for line in speech):
        write_captions(speech, [probe(line["localPath"]) for line in speech])
    if args.title_preview:
        run(["-y", "-loop", "1", "-framerate", FPS, "-i", TITLE, "-t", 6,
             "-vf", "format=yuv420p,fade=t=in:st=0:d=0.18,fade=t=out:st=5.35:d=0.65",
             "-c:v", "libx264", "-preset", "fast", "-crf", 18, "-an", "-movflags", "+faststart",
             ROOT / "edit/title-preview.mp4"], log=ROOT / "edit/title-preview.log")
    if not args.prepare_only:
        render(state)
    else:
        print(json.dumps({"title_card": str(TITLE), "render_ready": True,
                          "note": "Full render starts only when all six local clip files exist."},
                         ensure_ascii=False))


if __name__ == "__main__":
    main()
