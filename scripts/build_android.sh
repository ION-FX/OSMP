#!/usr/bin/env bash
# Build the OSMP Android APK (debug + signed release) with the local SDK.
# Usage: bash scripts/build_android.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export JAVA_HOME="${JAVA_HOME:-/home/vm/jdks/jdk-17.0.20+8}"
export ANDROID_HOME="${ANDROID_HOME:-/home/vm/tools/android}"
GRADLE="${GRADLE:-/home/vm/tools/gradle-8.9/bin/gradle}"

echo "sdk.dir=$ANDROID_HOME" > "$ROOT/android/local.properties"

# release keystore (stable, gitignored)
KS="$ROOT/android/keystore/osmp-release.jks"
if [ ! -f "$KS" ]; then
  mkdir -p "$(dirname "$KS")"
  "$JAVA_HOME/bin/keytool" -genkeypair -v \
    -keystore "$KS" -alias osmp -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass osmp-release -keypass osmp-release \
    -dname "CN=OSMP, OU=OSMP, O=OSMP, L=Local, S=Local, C=XX" >/dev/null
  echo "generated keystore: $KS"
fi

cd "$ROOT/android"
"$GRADLE" --no-daemon -q assembleRelease assembleDebug

echo
echo "── artifacts ──"
ls -la app/build/outputs/apk/release/*.apk app/build/outputs/apk/debug/*.apk

echo
echo "── release APK verification ──"
APK=$(ls app/build/outputs/apk/release/*.apk | head -1)
"$ANDROID_HOME/build-tools/34.0.0/aapt2" dump badging "$APK" 2>/dev/null | head -4
"$JAVA_HOME/bin/java" -version 2>&1 | head -1
echo "signed:"
"$ANDROID_HOME/build-tools/34.0.0/apksigner" verify --print-certs "$APK" 2>&1 | head -4
