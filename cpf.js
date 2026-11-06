// Mantém só dígitos
function normalizeCpf(value) {
  return String(value || '').replace(/\D/g, '');
}

// Valida CPF pelos dígitos verificadores
function isValidCpf(value) {
  const cpf = normalizeCpf(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (let t = 9; t < 11; t++) {
    let sum = 0;
    for (let i = 0; i < t; i++) sum += Number(cpf[i]) * (t + 1 - i);
    const digit = ((sum * 10) % 11) % 10;
    if (digit !== Number(cpf[t])) return false;
  }
  return true;
}

module.exports = { normalizeCpf, isValidCpf };
