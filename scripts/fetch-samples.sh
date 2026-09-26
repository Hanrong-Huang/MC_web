#!/bin/bash
# download raw source samples (Salamander v3 FLAC, VSCO-2 CE WAV) into <work>/raw/
# usage: bash scripts/fetch-samples.sh <work dir>   (then encode-samples.mjs)
S="${1:?usage: fetch-samples.sh <work dir>}"
mkdir -p "$S/raw/piano" "$S/raw/harp" "$S/raw/cello" "$S/raw/viola" "$S/raw/violin" "$S/raw/flute" "$S/raw/glock"
cd "$S/raw"
H=https://raw.githubusercontent.com
SAL=$H/sfzinstruments/SalamanderGrandPiano/master/Samples
for n in C1 F%231 C2 D%232 F%232 A2 C3 D%233 F%233 A3 C4 D%234 F%234 A4 C5 D%235 F%235 A5 C6 F%236 C7; do
  f=$(echo $n | sed 's/%23/s/'); curl -sSfL "$SAL/${n}v6.flac" -o "piano/$f.flac" &
done
curl -sSfL "$SAL/C4v10.flac" -o piano/C4_v10.flac &
curl -sSfL "$SAL/C4v3.flac" -o piano/C4_v3.flac &
wait
V=$H/sgossner/VSCO-2-CE/master
for n in E1_f G1_mp B1_mf D2_mf F2_mf A2_mf C3_mf E3_mf G3_mf B3_mf D4_mf F4_mf A4_mf C5_mf E5_mf G5_mf B5_mf D6_mf F6_mf A6_mf; do curl -sSfL "$V/Strings/Harp/KSHarp_$n.wav" -o "harp/$n.wav" & done; wait
for n in C1 E1 G1 B1 D2 F2 A2 C3 E3 G3 B3 D4 F4; do curl -sSfL "$V/Strings/Cello%20Section/susvib/susvib_${n}_v1_1.wav" -o "cello/$n.wav" & done; wait
for n in C2 D2 E2 G2 B2 D3 F3 A3 C4 E4 G4 B4 D5; do curl -sSfL "$V/Strings/Viola%20Section/susvib/ViolaEns_susvib_${n}_v1_1.wav" -o "viola/$n.wav" & done; wait
for n in G2 A2 B2 D3 F%233 A3 C4 E4 G4 B4 D5; do f=$(echo $n | sed 's/%23/s/'); curl -sSfL "$V/Strings/Violin%20Section/susVib/VlnEns_susVib_${n}_v1.wav" -o "violin/$f.wav" & done; wait
for n in C3 E3 A3 C4 E4 A4 C5 E5 A5 C6; do curl -sSfL "$V/Woodwinds/Flute/susvib/LDFlute_susvib_${n}_v1_1.wav" -o "flute/$n.wav" & done; wait
for n in G4 C5 G5 C6 G6 C7; do curl -sSfL "$V/Percussion/Glock/glock_medium_$n.wav" -o "glock/$n.wav" & done; wait
du -sh *
