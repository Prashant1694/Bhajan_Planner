const fs = require('fs');
const path = require('path');
const https = require('https');

const files = [
  'c.wav', 'cs.wav', 'd.wav', 'ds.wav',
  'e.wav', 'f.wav', 'fs.wav', 'g.wav',
  'gs.wav', 'a.wav', 'as.wav', 'b.wav',
  'mc.wav', 'mcs.wav', 'md.wav', 'mds.wav',
  'me.wav', 'mf.wav', 'mfs.wav', 'mg.wav',
  'mgs.wav', 'ma.wav', 'mas.wav', 'mb.wav'
];

const targetDir = path.join(__dirname, '..', 'public', 'audio', 'tanpura');
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

function downloadFile(file) {
  return new Promise((resolve, reject) => {
    const dest = path.join(targetDir, file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 100000) {
      console.log(`Skipping existing valid file: ${file}`);
      return resolve();
    }
    const url = `https://raw.githubusercontent.com/swikar-napit/tanpura-web/main/audio/${file}`;
    const fileStream = fs.createWriteStream(dest);

    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        fileStream.close();
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        return reject(new Error(`Failed to download ${file}: HTTP ${res.statusCode}`));
      }
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        console.log(`Downloaded ${file} (${fs.statSync(dest).size} bytes)`);
        resolve();
      });
    }).on('error', (err) => {
      fileStream.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

async function run() {
  console.log(`Downloading ${files.length} acoustic Tanpura sample files...`);
  for (const f of files) {
    try {
      await downloadFile(f);
    } catch (e) {
      console.error(`Error on ${f}:`, e.message);
    }
  }
  console.log('All downloads completed!');
}

run();
