// src/cronJobs/cuotasCron.js

import cron from 'node-cron';
import { actualizarCuotasVencidas } from '../services/cuota.service.js';

export const initCuotasCron = async () => {
  // 1️⃣ Actualizo apenas inicie el servidor
  try {
    const inicial = await actualizarCuotasVencidas();
    console.log(`▶ Inicial ► Cuotas vencidas marcadas: ${inicial}`);
  } catch (err) {
    console.error('▶ Inicial ► Error actualizando cuotas vencidas:', err);
  }

  // 2️⃣ Programo el cron diario a las 2 AM hora Tucumán
  cron.schedule(
    '0 2 * * *',
    async () => {
      console.log('🔁 Cron ► Actualización de cuotas vencidas');
      try {
        const resultado = await actualizarCuotasVencidas();
        console.log('✅ Cron ► Cuotas vencidas actualizadas:', resultado);
      } catch (error) {
        console.error('❌ Cron ► Error al actualizar cuotas vencidas:', error);
      }
    },
    {
      timezone: 'America/Argentina/Tucuman'
    }
  );
};
