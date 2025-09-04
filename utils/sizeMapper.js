// utils/sizeMapper.js

function getDimensions(size, quality) {
  const base = quality === "hd" ? 2048 : 1024;

  switch (size) {
    case "1:1":
      return { width: base, height: base };
    case "2:3":
      return { width: base, height: Math.round(base * 1.5) };
    case "3:2":
      return { width: Math.round(base * 1.5), height: base };
    case "9:16":
      return { width: Math.round(base * 0.5625), height: base }; // 576x1024 or 1152x2048
    case "16:9":
      return { width: base, height: Math.round(base * 0.5625) }; // 1024x576 or 2048x1152
    default:
      return { width: base, height: base };
  }
}

module.exports = { getDimensions };
