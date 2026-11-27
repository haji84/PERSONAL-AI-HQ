import {createHash} from 'node:crypto';

const imageByteLimit = 512 * 1024;
const imageBase64Limit = 4 * Math.ceil(imageByteLimit / 3);
const pngMagic = Buffer.from('89504e470d0a1a0a', 'hex');
const jpegMagic = Buffer.from('ffd8ff', 'hex');
const imageSignatures = new Map([
  ['image/png', bytes => bytes.subarray(0, pngMagic.length).equals(pngMagic)],
  ['image/jpeg', bytes => bytes.subarray(0, jpegMagic.length).equals(jpegMagic)],
  ['image/webp', bytes => bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP'],
]);

const problem = (status, message) => Object.assign(new Error(message), {status});

export function validatedImage(value) {
  if (value === undefined) return null;
  const invalid = () => problem(400, 'PNG、JPEG、WebPの画像を1枚指定してください。');
  const tooLarge = () => problem(413, '画像は512 KiB以下にしてください。');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'mime') || !Object.hasOwn(value, 'data')) throw invalid();
  const {mime, data} = value;
  const matches = imageSignatures.get(mime);
  if (!matches || typeof data !== 'string' || !data.length) throw invalid();
  if (data.length > imageBase64Limit) throw tooLarge();
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data || !matches(bytes)) throw invalid();
  if (bytes.length > imageByteLimit) throw tooLarge();
  return {image: {mime, data}, size: bytes.length, digest: createHash('sha256').update(bytes).digest('hex')};
}
