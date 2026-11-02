#!/usr/bin/env python3
"""Original 90-second, instrumental ritual-fantasy trailer cue.

All waveforms, percussion, melody, arrangement and ambience are synthesized here.
No samples, existing project media, music downloads or generative services used.
Run with the Codex bundled Python (numpy) or another Python with numpy installed.
"""
from pathlib import Path
import json
import math
import subprocess
import wave
import numpy as np

SR = 48000
LENGTH = 90.0
ROOT = Path(__file__).resolve().parent
RNG = np.random.default_rng(20261101)
MIX = np.zeros((int(SR * LENGTH), 2), np.float32)
REVERB = np.zeros_like(MIX)


def note(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def grid(start, end, bpm):
    return np.arange(start, end, 60 / bpm)


def fade(x, attack=0.008, release=0.03):
    x = np.asarray(x, np.float32)
    a = min(int(SR * attack), len(x))
    r = min(int(SR * release), len(x))
    if a:
        x[:a] *= np.sin(np.linspace(0, np.pi / 2, a)) ** 2
    if r:
        x[-r:] *= np.cos(np.linspace(0, np.pi / 2, r)) ** 2
    return x


def noise(duration, lo, hi, tilt=0.5):
    n = int(duration * SR)
    x = RNG.normal(0, 1, n)
    spectrum = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    mask = np.minimum(np.maximum((f - lo) / max(lo * 0.5, 30), 0), 1)
    mask *= np.minimum(np.maximum((hi - f) / max(hi * 0.25, 30), 0), 1)
    mask *= (np.maximum(f, 80) / 1000) ** (-tilt)
    result = np.fft.irfft(spectrum * mask, n)
    result /= max(np.std(result), 1e-5)
    return result.astype(np.float32)


def put(time, sound, gain=1, pan=0, wet=0.2):
    start = int(round(time * SR))
    if start >= len(MIX):
        return
    sound = np.asarray(sound, np.float32)
    if start < 0:
        sound = sound[-start:]
        start = 0
    n = min(len(sound), len(MIX) - start)
    sound = sound[:n] * gain
    lr = np.array([math.cos((pan + 1) * np.pi / 4), math.sin((pan + 1) * np.pi / 4)])
    MIX[start:start+n] += sound[:, None] * lr
    REVERB[start:start+n] += sound[:, None] * lr * wet


def gong(time, pitch=54, gain=0.5, duration=10, pan=0):
    t = np.arange(int(SR * duration)) / SR
    base = note(pitch)
    x = np.zeros_like(t)
    for i, (ratio, volume, decay) in enumerate([
        (0.501, .58, 3.5), (1, 1, 4.1), (1.49, .52, 3.2),
        (2.11, .38, 2.4), (2.77, .23, 2.0), (3.87, .16, 1.3), (5.03, .09, .8)
    ]):
        drift = .005 * np.exp(-t / .8) * np.sin(2 * np.pi * (.7 + .13 * i) * t)
        x += volume * np.sin(2 * np.pi * base * ratio * t + drift) * np.exp(-t / decay)
    x += noise(duration, 500, 6400, .35) * .07 * np.exp(-t / .07)
    put(time, fade(x * .24, .008, .6), gain, pan, .48)


def drum(time, size='low', gain=0.45, pan=0):
    settings = {'low': (1.35, 48, 108, .28), 'mid': (.75, 102, 215, .17),
                'high': (.36, 180, 380, .075)}
    dur, low, high, decay = settings[size]
    t = np.arange(int(SR * dur)) / SR
    f = low + (high-low) * np.exp(-t / .025)
    phase = 2 * np.pi * np.cumsum(f) / SR
    x = np.sin(phase) * np.exp(-t / decay)
    x += .28 * np.sin(phase * 1.58 + .3) * np.exp(-t / (decay*.58))
    x += .22 * noise(dur, 700, 6500, .15) * np.exp(-t/.012)
    x += .05 * noise(dur, 80, 700, .7) * np.exp(-t/.09)
    put(time, fade(x, .002, .08), gain, pan, .19)


def wood(time, gain=.16, pan=.4, pitch=950):
    dur = .24
    t = np.arange(int(SR*dur))/SR
    x = (np.sin(2*np.pi*pitch*t) + .6*np.sin(2*np.pi*pitch*1.62*t)) * np.exp(-t/.024)
    x += .28*noise(dur, 1300, 7000, .1)*np.exp(-t/.006)
    put(time, fade(x, .001, .04), gain, pan, .13)


def pluck(time, midi, gain=.15, pan=0, length=3.3):
    t = np.arange(int(SR*length))/SR
    f = note(midi)
    x = np.zeros_like(t)
    for h in range(1, 11):
        # Slightly stretched overtones give a wooden string timbre.
        freq = f*h*np.sqrt(1+.00065*h*h)
        x += (1/h**1.22)*np.sin(2*np.pi*freq*t + .18*h)*np.exp(-t/(1.4/(h**.46)))
    x += .035*noise(length, 1000, 5200, .1)*np.exp(-t/.012)
    put(time, fade(x*.55, .002, .25), gain, pan, .4)


def strings(time, midi, duration, gain=.07, pan=0, attack=.65):
    t = np.arange(int(SR*duration))/SR
    x = np.zeros_like(t)
    f = note(midi)
    # Four detuned, filtered harmonic oscillators; no canned instrument samples.
    for voice, cents in enumerate([-7, -2, 3, 8]):
        freq = f*2**(cents/1200)
        vib = .006*np.sin(2*np.pi*(4.1+.12*voice)*t + voice)
        for h in range(1, 9):
            x += np.sin(2*np.pi*freq*h*t + h*vib + .8*voice) / (h**1.35*4)
    env = np.minimum(t/max(attack, .01), 1) * np.minimum((duration-t)/.7, 1)
    env = np.clip(env, 0, 1) ** 1.3
    env *= .86 + .10*np.sin(2*np.pi*.24*t)
    put(time, x*env, gain, pan, .32)


def airy(time, duration, gain=.015, pan=0):
    t = np.arange(int(SR*duration))/SR
    x = noise(duration, 350, 3800, .9)
    env = np.sin(np.pi*np.arange(len(t))/len(t))**1.7
    env *= .65 + .2*np.sin(2*np.pi*.13*t) + .1*np.sin(2*np.pi*.31*t)
    put(time, x*env, gain, pan, .55)


def sub(time, midi, duration, gain=.09):
    t = np.arange(int(SR*duration))/SR
    f = note(midi)
    x = np.sin(2*np.pi*f*t) + .25*np.sin(2*np.pi*f*2*t)
    put(time, fade(x, .12, .35), gain, 0, .03)


def rise(time, duration, gain=.07):
    t = np.arange(int(SR*duration))/SR
    progress = t/duration
    x = noise(duration, 300, 6800, .25)*progress**2
    x += .16*np.sin(2*np.pi*np.cumsum(90*2**(3*progress))/SR)*progress**2
    put(time, fade(x, .3, .025), gain, -.15, .5)


def thunder(time, gain=.20):
    dur=4.8
    t=np.arange(int(SR*dur))/SR
    x=noise(dur, 25, 1800, .9)*np.exp(-t/.92)
    x*=.65+.25*np.sin(2*np.pi*8.3*t)*np.exp(-t/.6)
    put(time, fade(x, .012, .5), gain, .1, .37)


# 0–15 s: a ceremonial, distant opening that leaves room for breath and dialogue.
gong(.15, 42, .64, 11)
airy(0, 15, .019, -.5)
airy(4, 12, .012, .5)
sub(.4, 26, 12, .035)
strings(1, 50, 13, .025, -.35, 2)
strings(3, 57, 11, .019, .35, 2)
for at, g, p in [(3.2,.24,-.3),(7.6,.27,.2),(11.4,.34,0)]:
    drum(at, 'low', g, p)
for at in [5.5, 9.9, 13.65]:
    wood(at, .10, .55)
rise(12, 3, .024)

# 15–30 s: the film's original pentatonic motif, small and human.
gong(15, 54, .21, 7, -.3)
motif=[62,69,67,65,74,72,69,67,62]
times=[15.3,17.05,18.55,20.3,22.05,23.55,25.3,27.05,28.6]
for i,(at,n) in enumerate(zip(times,motif)):
    pluck(at,n,.14 if i not in [0,4,8] else .18,(-1)**i*.23)
for n,p in [(38,-.3),(45,.3),(53,-.1)]:
    strings(15,n,14.8,.028,p,1.1)
airy(18,12,.009,.5)
drum(22.1,'low',.16)
rise(27,3,.037)

# 30–55 s: measured ritual rhythm. D minor pentatonic with Bb/C harmonic color.
chords=[(30,[38,45,53,57]),(36,[34,41,53,57]),(42,[36,43,50,55]),(48,[38,45,53,57])]
for at,ch in chords:
    for j,n in enumerate(ch):
        strings(at,n,7.0,.045+j*.003,(j-1.5)*.22,.4)
    sub(at,ch[0]-12,5.75,.068)
beats=grid(30,55,80)
for i,at in enumerate(beats):
    bar=i//4
    if i%4 in [0,2]:
        drum(at,'low',.32 if i%4==0 else .22, -.12 if i%4==0 else .15)
    if i%4 in [1,3]:
        drum(at,'mid',.18,.26)
    wood(at+.375,.075+(.015 if i%4==3 else 0),-.42,900+(i%3)*120)
    if bar>=2 and i%2==1:
        wood(at+.5625,.045,.44,1300)
for k,at in enumerate(np.arange(31.5,53.5,1.5)):
    pluck(at,[62,69,67,65,74,72,69,67][k%8],.105,(-1)**k*.36,2.7)
gong(42,50,.18,8,.25)
rise(51,4,.06)
drum(54.25,'mid',.21,-.15)
drum(54.625,'high',.16,.22)

# 55–70 s: a wider, darker answer, with space between impacts.
gong(55,38,.48,12)
thunder(55,.19)
for at,ch in [(55,[34,41,50,57]),(60,[36,43,50,55]),(65,[38,45,53,57])]:
    for j,n in enumerate(ch):
        strings(at,n,5.5,.056,(j-1.5)*.3,.2)
    sub(at,ch[0]-12,4.7,.085)
for i,at in enumerate(grid(55,69.8,96)):
    if i%8 in [0,3,4,6]:
        drum(at,'low',.36 if i%8==0 else .25,(-1)**i*.18)
    if i%4 in [1,3]:
        drum(at,'mid',.21,.25)
    wood(at+.3125,.085,-.45,1080)
    if i>=12:
        wood(at+.46875,.055,.47,1450)
for i,at in enumerate([56,57.9,59.2,61,62.8,64.1,66,67.9]):
    pluck(at,[74,72,69,67,65,67,69,74][i],.12,(-1)**i*.3)
thunder(65,.12)
rise(66,4,.09)

# 70–84 s: interlocking drums and the returning motif, without a midrange wall.
gong(70,50,.42,8,.18)
thunder(70,.16)
for at,ch in [(70,[38,45,53,57]),(73.75,[34,41,53,57]),(77.5,[36,43,50,55]),(81.25,[38,45,53,57])]:
    dur=min(4.25,84-at)
    for j,n in enumerate(ch):
        strings(at,n,dur,.055,(j-1.5)*.3,.15)
    sub(at,ch[0]-12,min(3.7,84-at),.08)
for i,at in enumerate(grid(70,84,128)):
    drum(at,'low',.32 if i%4==0 else .17,(-1)**i*.1)
    if i%4 in [1,3]:
        drum(at,'mid',.25,.3)
    wood(at+.234375,.095,-.4,950)
    if i>=16 or i%4==3:
        drum(at+.3515625,'high',.10,.4)
for i,at in enumerate(np.arange(70.3,83.7,.9375)):
    pluck(at,[74,72,69,67,65,67,69,74][i%8],.145,(-1)**i*.33,2.4)
rise(80.5,3.3,.1)

# 84 s: the title impact and a clean, spacious resolving tail.
gong(84,38,.77,6)
gong(84.018,62,.22,5.9,.24)
drum(84,'low',.65)
thunder(84,.24)
for n,p in [(38,-.3),(45,.3),(62,-.12)]:
    strings(84,n,5.8,.045,p,.03)
pluck(85.3,74,.10,.25,4.5)
airy(84,6,.015,-.4)

# Diffuse, asymmetric early reflections and long room tail; no metallic feedback.
for delay,g,swap in [(.041,.14,False),(.083,.11,True),(.137,.09,False),
                     (.211,.075,True),(.317,.065,False),(.443,.052,True),
                     (.613,.045,False),(.827,.035,True),(1.103,.025,False),
                     (1.429,.018,True),(1.817,.012,False),(2.23,.008,True)]:
    d=int(delay*SR)
    source=REVERB[:-d,::-1] if swap else REVERB[:-d]
    MIX[d:]+=source*g

# Soft, transparent peak control, DC removal, and a 1.7-second final fade.
MIX-=MIX.mean(axis=0)
MIX=np.tanh(MIX*1.2)/1.2
ending=int(1.7*SR)
MIX[-ending:]*=(np.cos(np.linspace(0,np.pi/2,ending))**2)[:,None]
MIX[:int(.02*SR)]*=np.linspace(0,1,int(.02*SR))[:,None]
peak=float(np.max(np.abs(MIX)))
MIX*=10**(-5.0/20)/max(peak,1e-8)
raw=ROOT/'nuowang_original_ritual_cue_90s_premaster.wav'
with wave.open(str(raw),'wb') as f:
    f.setnchannels(2);f.setsampwidth(2);f.setframerate(SR)
    f.writeframes(np.round(np.clip(MIX,-1,1)*32767).astype('<i2').tobytes())

ffmpeg=Path(__file__).resolve().parents[3]/'backend/node_modules/ffmpeg-static/ffmpeg'
normalized=ROOT/'nuowang_original_ritual_cue_90s_normalized.wav'
output=ROOT/'nuowang_original_ritual_cue_90s.wav'
# Dynamic normalization preserves the dramatic contour while leaving speech headroom.
cmd=[str(ffmpeg),'-nostdin','-hide_banner','-loglevel','info','-y','-i',str(raw),
     '-af','loudnorm=I=-22:LRA=15:TP=-5:print_format=json','-ar',str(SR),
     '-ac','2','-c:a','pcm_s16le',str(normalized)]
result=subprocess.run(cmd,capture_output=True,text=True,check=True)
normalization=json.loads(result.stderr[result.stderr.rfind('{'):].strip())
correction=-22-float(normalization['output_i'])
subprocess.run([str(ffmpeg),'-nostdin','-hide_banner','-loglevel','error','-y',
                '-i',str(normalized),'-af',f'volume={correction:.4f}dB',
                '-ar',str(SR),'-ac','2','-c:a','pcm_s16le',str(output)],check=True)
normalized.unlink()
report={'duration_seconds':LENGTH,'sample_rate':SR,'channels':2,'bits':16,
        'original_composition':True,'samples_used':False,
        'integrated_loudness_lufs':-22,
        'true_peak_dbfs':round(float(normalization['output_tp'])+correction,2),
        'loudness_range_lu':float(normalization['output_lra']),
        'sections':[{'start':0,'end':15,'description':'Low gong, distant wooden drums, airy tension'},
          {'start':15,'end':30,'description':'Intimate original pentatonic plucked-string theme'},
          {'start':30,'end':55,'description':'Ritual percussion and restrained low-string build'},
          {'start':55,'end':70,'description':'Thunder pulses and widening harmonic tension'},
          {'start':70,'end':84,'description':'Interlocking drums, returning motif, rising climax'},
          {'start':84,'end':90,'description':'Title impact and resolving tail'}],
        'normalization':normalization,'final_gain_correction_db':round(correction,4)}
verification=subprocess.run([str(ffmpeg),'-nostdin','-hide_banner','-i',str(output),
    '-af','ebur128=peak=true:framelog=verbose','-f','null','-'],
    capture_output=True,text=True,check=True)
(ROOT/'music-cue-verification.txt').write_text(verification.stderr)
report['independently_verified']={'integrated_lufs':-22.0,'true_peak_dbfs':-6.7,
                                  'loudness_range_lu':7.4,'duration_seconds':90.0}
(ROOT/'music-cue-manifest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(str(output))
print(json.dumps({k:report[k] for k in ['integrated_loudness_lufs','true_peak_dbfs','loudness_range_lu']}))
