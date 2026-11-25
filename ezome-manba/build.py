#!/usr/bin/env python3
"""ezome/index.html dan internet versiyasini yig'adi: public/index.html"""
import re, pathlib, sys
ROOT = pathlib.Path(__file__).parent
BLAZE = '--blaze' in sys.argv  # Firebase Blaze tarifi
FIREBASE = '--firebase' in sys.argv or BLAZE  # aks holda Supabase
args = [a for a in sys.argv[1:] if not a.startswith('--')]
src = pathlib.Path(args[0] if args else ROOT.parent / 'ezome' / 'index.html').read_text(encoding='utf-8')
P = '' if not FIREBASE else '/'  # Supabase versiyasi istalgan manzil/papkada ishlashi uchun nisbiy yo'llar
head = (f'<link rel="manifest" href="{P}manifest.webmanifest">\n<meta name="theme-color" content="#1f6bff">\n'
        '<meta name="mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-capable" content="yes">\n'
        f'<link rel="apple-touch-icon" href="{P}icons/apple-180.png">\n<link rel="icon" href="{P}icons/favicon-32.png">\n')
i = src.index('\n</head>')
src = src[:i + 1] + head + src[i + 1:]
if FIREBASE:
    libs = ''.join(f'<script src="/vendor/firebase-{m}-compat.js"></script>\n' for m in (['app', 'auth', 'firestore', 'storage', 'functions'] if BLAZE else ['app', 'auth', 'firestore']))
    libs += '<script src="/firebase-config.js"></script>\n'
else:
    libs = '<script src="vendor/supabase.js"></script>\n<script src="config.js"></script>\n'
i = src.index('<script>/*! qrcode-generator')
src = src[:i] + libs + src[i:]
sw = "<script>if('serviceWorker' in navigator&&location.protocol==='https:')addEventListener('load',()=>navigator.serviceWorker.register('" + P + "sw.js').catch(()=>{}))</script>\n"
i = src.rindex('</body>')
src = src[:i] + sw + src[i:]
out = ROOT / 'public' / 'index.html'
out.write_text(src, encoding='utf-8')
print('yig\'ildi:', out, len(src) // 1024, 'KB')
