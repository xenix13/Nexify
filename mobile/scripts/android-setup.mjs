// Complète le projet Android généré par « npx cap add android » :
// moteur local (NewPipeExtractor + serveur HTTP local), service de lecture, permissions,
// numéro de version et signature (si les secrets du dépôt sont configurés).
// Gère les fichiers Gradle en Groovy (build.gradle) comme en Kotlin (build.gradle.kts).
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '..');
const android = path.join(root, 'android');
const app = path.join(android, 'app');
const read = (f) => fs.readFileSync(f, 'utf8');
const write = (f, s) => fs.writeFileSync(f, s);
const pick = (dir, name) => {
  const kts = path.join(dir, `${name}.kts`);
  return fs.existsSync(kts) ? { file: kts, kts: true } : { file: path.join(dir, name), kts: false };
};

const NPE = 'com.github.TeamNewPipe:NewPipeExtractor:e8f89145a830b4d6cae32412007f24ea8b36c73a'; // version de l'appli NewPipe
const DEPS = [
  ['implementation', NPE],
  ['implementation', 'org.nanohttpd:nanohttpd:2.3.1'],
  ['implementation', 'com.squareup.okhttp3:okhttp:4.12.0'],
  ['coreLibraryDesugaring', 'com.android.tools:desugar_jdk_libs_nio:2.1.5'],
];

// 1. sources Java
const javaSrc = path.join(root, 'native', 'java', 'fr', 'nexify', 'app');
const javaDst = path.join(app, 'src', 'main', 'java', 'fr', 'nexify', 'app');
fs.mkdirSync(javaDst, { recursive: true });
for (const f of fs.readdirSync(javaSrc)) fs.copyFileSync(path.join(javaSrc, f), path.join(javaDst, f));

// 2. dépôt JitPack (NewPipeExtractor)
const settings = pick(android, 'settings.gradle');
const rootBuild = pick(android, 'build.gradle');
const jitpack = (kts) => (kts ? 'maven { url = uri("https://jitpack.io") }' : "maven { url 'https://jitpack.io' }");
let st = fs.existsSync(settings.file) ? read(settings.file) : '';
if (/dependencyResolutionManagement\s*\{[\s\S]*?repositories\s*\{/.test(st)) {
  if (!st.includes('jitpack.io')) {
    st = st.replace(/(dependencyResolutionManagement\s*\{[\s\S]*?repositories\s*\{)/, `$1\n        ${jitpack(settings.kts)}`);
    write(settings.file, st);
  }
} else {
  let rg = read(rootBuild.file);
  if (!rg.includes('jitpack.io')) {
    rg += `\nallprojects {\n    repositories {\n        ${jitpack(rootBuild.kts)}\n    }\n}\n`;
    write(rootBuild.file, rg);
  }
}

// 3. module app : version, dépendances, désucrage Java, signature
const appBuild = pick(app, 'build.gradle');
const K = appBuild.kts;
let ag = read(appBuild.file);
const pkg = JSON.parse(read(path.join(root, 'package.json')));
const run = Number(process.env.GITHUB_RUN_NUMBER || 1);
const [maj, min, pat] = pkg.version.split('.').map(Number);
const code = maj * 1_000_000 + min * 10_000 + pat * 100 + (run % 100);
ag = K
  ? ag.replace(/versionCode\s*=\s*\d+/, `versionCode = ${code}`).replace(/versionName\s*=\s*"[^"]*"/, `versionName = "${pkg.version}"`)
  : ag.replace(/versionCode\s+\d+/, `versionCode ${code}`).replace(/versionName\s+"[^"]*"/, `versionName "${pkg.version}"`);
if (!ag.includes('NewPipeExtractor')) {
  ag += K ? `
android {
    compileOptions {
        isCoreLibraryDesugaringEnabled = true
    }
    packaging {
        resources.excludes += setOf("META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }
}

dependencies {
${DEPS.map(([c, d]) => `    ${c}("${d}")`).join('\n')}
}
` : `
android {
    compileOptions {
        coreLibraryDesugaringEnabled true
    }
    packaging {
        resources {
            excludes += ['META-INF/DEPENDENCIES', 'META-INF/LICENSE*', 'META-INF/NOTICE*']
        }
    }
}

dependencies {
${DEPS.map(([c, d]) => `    ${c} '${d}'`).join('\n')}
}
`;
}
if (process.env.NEXIFY_KEYSTORE && !ag.includes('NEXIFY_KEYSTORE')) {
  ag += K ? `
android {
    signingConfigs {
        create("nexify") {
            storeFile = file(System.getenv("NEXIFY_KEYSTORE"))
            storePassword = System.getenv("NEXIFY_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("NEXIFY_KEY_ALIAS")
            keyPassword = System.getenv("NEXIFY_KEY_PASSWORD")
        }
    }
    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("nexify")
        }
    }
}
` : `
android {
    signingConfigs {
        nexify {
            storeFile file(System.getenv('NEXIFY_KEYSTORE'))
            storePassword System.getenv('NEXIFY_KEYSTORE_PASSWORD')
            keyAlias System.getenv('NEXIFY_KEY_ALIAS')
            keyPassword System.getenv('NEXIFY_KEY_PASSWORD')
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.nexify
        }
    }
}
`;
}
write(appBuild.file, ag);

// 4. manifeste : service de lecture, permissions, trafic HTTP (moteur local, serveur sur le réseau local)
const manifest = path.join(app, 'src', 'main', 'AndroidManifest.xml');
let mf = read(manifest);
for (const p of [
  'android.permission.INTERNET',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.WAKE_LOCK',
]) {
  if (!mf.includes(`"${p}"`)) mf = mf.replace('</manifest>', `    <uses-permission android:name="${p}" />\n</manifest>`);
}
if (!mf.includes('usesCleartextTraffic')) mf = mf.replace('<application', '<application\n        android:usesCleartextTraffic="true"');
if (!mf.includes('PlaybackService')) {
  mf = mf.replace('</application>', '        <service android:name=".PlaybackService" android:exported="false" android:foregroundServiceType="mediaPlayback" />\n    </application>');
}
write(manifest, mf);
console.log(`Projet Android complété (${K ? 'Kotlin' : 'Groovy'} : moteur local, service de lecture, permissions, version ${pkg.version} / ${code}).`);
