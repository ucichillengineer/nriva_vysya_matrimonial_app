export async function recognizeImage(_file: unknown, _onProgress: (percent: number) => void): Promise<string> {
  throw new Error('OCR currently runs in the web app. On iOS and Android, paste the biodata text and add photos manually.');
}
