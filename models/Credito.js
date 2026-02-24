import { DataTypes, Sequelize } from 'sequelize';
import sequelize from './sequelize.js';
import Usuario from './Usuario.js';
import Cliente from './Cliente.js';

/**
 * Definición:
 * - tipo_credito: periodicidad del cálculo de interés (semanal | quincenal | mensual)
 * - modalidad_credito: variante de negocio (comun | progresivo | libre)
 *
 * Notas para "libre":
 * - No hay vencimientos ni mora (lo maneja la capa de servicios/cuotas).
 * - saldo_actual se usa como "capital pendiente".
 * - interes_acumulado guarda el interés del ciclo no cubierto (si aplica).
 * - El descuento por pago total/adelantado se reflejará en Recibos.
 *
 * NUEVO:
 * - total_actual: campo que refleja el total actual del crédito considerando
 *   saldo_actual + interes_acumulado + intereses vencidos (si corresponde).
 *   Se actualiza desde la capa de servicios (no se recalcula automáticamente
 *   por DB). Se define aquí para facilitar consultas y ordenamientos.
 *
 * - origen_venta_manual_financiada: marca si el crédito fue generado
 *   automáticamente desde una VentaManual financiada.
 * - detalle_producto: describe el producto/servicio asociado a la venta
 *   financiada que originó este crédito (cuando aplique).
 */

const Credito = sequelize.define(
    'Credito',
    {
        cliente_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: Cliente, key: 'id' }
        },
        cobrador_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: { model: Usuario, key: 'id' }
        },
        monto_acreditar: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false
        },
        fecha_solicitud: {
            type: DataTypes.DATEONLY,
            allowNull: false,
            defaultValue: DataTypes.NOW
        },
        fecha_acreditacion: {
            type: DataTypes.DATEONLY,
            allowNull: false
        },
        fecha_compromiso_pago: {
            type: DataTypes.DATEONLY,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_DATE')
        },
        interes: {
            // Guardás 60 ó 0.60 según la carga; en servicios lo voy a interpretar
            // de forma robusta para ambas variantes sin romper nada.
            //
            // FIX: evitar "Numeric field overflow" cuando el interés supera 999.99
            // (ej: semanal con muchas cuotas -> 1425.00 / 1440.00, etc.)
            // DB ya fue alterada a NUMERIC(8,2) para mantener consistencia.
            type: DataTypes.DECIMAL(8, 2),
            allowNull: false
        },
        tipo_credito: {
            // Periodicidad del interés: semanal/quincenal/mensual
            type: DataTypes.ENUM('semanal', 'quincenal', 'mensual'),
            allowNull: false
        },
        cantidad_cuotas: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        monto_total_devolver: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false
        },

        // ——— Nuevos campos ———
        // En "libre": interpretar como capital pendiente.
        saldo_actual: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
            defaultValue: 0.0
        },
        // Interés del ciclo no cubierto (si aplica).
        interes_acumulado: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
            defaultValue: 0.0
        },
        // **TOTAL ACTUAL**: saldo + interés acumulado + (otros intereses/mora que calcule el service)
        // NOTA: Este campo se actualiza desde la capa de servicios cada vez que hay cambios
        // relevantes (registro de pagos, refrescar cuota libre, recalculo de mora, refinanciación, etc).
        total_actual: {
            type: DataTypes.DECIMAL(12, 2),
            allowNull: false,
            defaultValue: 0.0,
            comment: 'Saldo actual + intereses acumulados / mora (actualizado por el service)'
        },

        tasa_refinanciacion: {
            type: DataTypes.DECIMAL(5, 2),
            allowNull: true
        },
        modalidad_credito: {
            // Reutiliza el tipo existente en PG: creditos_modalidad_enum
            type: DataTypes.ENUM,
            values: ['comun', 'progresivo', 'libre'],
            enumName: 'creditos_modalidad_enum',
            allowNull: false,
            defaultValue: 'comun'
        },
        opcion_refinanciamiento: {
            type: DataTypes.ENUM,
            values: ['P1', 'P2', 'manual'],
            enumName: 'creditos_opcion_refinanciamiento_enum',
            allowNull: true
        },
        // Campo general del crédito (para compatibilidad con tu flujo actual).
        // Para el descuento por pago total/adelantado en "libre", guardaremos además
        // los datos en Recibo (tipo_operacion, descuento_porcentaje/monto, etc.).
        descuento: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
            defaultValue: 0.0
        },
        estado: {
            type: DataTypes.ENUM('pendiente', 'pagado', 'vencido', 'refinanciado', 'anulado'),
            defaultValue: 'pendiente'
        },
        id_credito_origen: {
            type: DataTypes.INTEGER,
            allowNull: true
        },

        // 🔹 Marca si viene de una venta manual financiada
        origen_venta_manual_financiada: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
            comment: 'true si el crédito se generó automáticamente desde una VentaManual financiada'
        },

        // 🔹 Detalle del producto que originó este crédito (si viene de venta financiada)
        detalle_producto: {
            type: DataTypes.STRING(255),
            allowNull: true,
            comment: 'Detalle / descripción del producto de la venta financiada que originó este crédito'
        }
    },
    {
        tableName: 'creditos',
        timestamps: false
    }
);

export default Credito;