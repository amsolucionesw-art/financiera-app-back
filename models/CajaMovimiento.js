// backend/src/models/CajaMovimiento.js
import { DataTypes } from "sequelize";
import sequelize from "./sequelize.js";
import FormaPago from "./FormaPago.js";

/* ───────────────── Helpers de normalización ───────────────── */
const toNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const fix2 = (n) => Math.round(toNumber(n) * 100) / 100;

/**
 * Normaliza números conservando el decimal correcto.
 * Reglas:
 * - Si tiene coma y punto → asumo "1.234,56": quito puntos y reemplazo coma por punto.
 * - Si solo tiene coma → reemplazo coma por punto.
 * - Si solo tiene punto → lo dejo tal cual (punto decimal real).
 * - Sino, parseo directo.
 */
const sanitizeNumber = (value) => {
    if (value === null || value === undefined) return 0;
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value === "string") {
        const s = value.trim();
        if (s === "") return 0;
        const hasComma = s.includes(",");
        const hasDot = s.includes(".");
        let norm = s;
        if (hasComma && hasDot) {
            // "1.234,56" → "1234.56"
            norm = s.replace(/\./g, "").replace(/,/g, ".");
        } else if (hasComma) {
            // "1234,56" → "1234.56"
            norm = s.replace(/,/g, ".");
        } else {
            // solo punto o sin separadores → dejar como está
            norm = s;
        }
        const n = Number(norm);
        return Number.isFinite(n) ? n : 0;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

/**
 * Movimientos de caja (ingresos/egresos/ajustes/apertura/cierre)
 * Mantiene trazabilidad opcional hacia entidades externas por (referencia_tipo, referencia_id).
 */
const CajaMovimiento = sequelize.define(
    "CajaMovimiento",
    {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        fecha: {
            type: DataTypes.DATEONLY,
            allowNull: false,
            defaultValue: DataTypes.NOW,
        },

        hora: {
            type: DataTypes.TIME,
            allowNull: false,
            // ✅ TIME necesita hora; DataTypes.NOW es timestamp y puede romper según casting
            defaultValue: sequelize.literal("CURRENT_TIME"),
        },

        /** 'ingreso' | 'egreso' | 'ajuste' | 'apertura' | 'cierre' */
        tipo: {
            type: DataTypes.ENUM("ingreso", "egreso", "ajuste", "apertura", "cierre"),
            allowNull: false,
        },

        monto: {
            // Si querés más holgura, podés subir a DECIMAL(14,2) (requiere migración).
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
            validate: { min: 0.01 },
            // 👉 devolver como Number en vez de string
            get() {
                const raw = this.getDataValue("monto");
                return raw == null ? null : parseFloat(raw);
            },
            // 👉 normalizar SIEMPRE antes de guardar (sin dividir por 100)
            set(val) {
                let n = sanitizeNumber(val);
                n = fix2(n);
                this.setDataValue("monto", n);
            },
        },

        /** Catálogo de formas de pago (opcional) */
        forma_pago_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },

        /** Descripción legible del movimiento */
        concepto: {
            type: DataTypes.STRING(255),
            allowNull: false,
        },

        /** Trazabilidad externa opcional (ej: 'recibo', 'pago', 'manual', etc.) */
        referencia_tipo: {
            type: DataTypes.STRING(50),
            allowNull: true,
        },

        referencia_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },

        /** Auditoría opcional */
        usuario_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
    },
    {
        tableName: "caja_movimientos",
        timestamps: false,
    }
);

/** Relación informativa a FormaPago */
CajaMovimiento.belongsTo(FormaPago, {
    foreignKey: "forma_pago_id",
    as: "formaPago",
});

export default CajaMovimiento;
