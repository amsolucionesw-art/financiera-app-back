'use strict';

export async function up(queryInterface, Sequelize) {
  await queryInterface.createTable('tareas_pendientes', {
    id: {
      type: Sequelize.INTEGER,
      autoIncrement: true,
      primaryKey: true
    },
    tipo: {
      type: Sequelize.STRING,
      allowNull: false
    },
    datos: {
      type: Sequelize.JSONB,
      allowNull: false
    },
    estado: {
      type: Sequelize.ENUM('pendiente', 'aprobada', 'rechazada'),
      defaultValue: 'pendiente'
    },
    creadoPor: {
      type: Sequelize.INTEGER,
      allowNull: false
    },
    aprobadoPor: {
      type: Sequelize.INTEGER,
      allowNull: true
    },
    fechaResolucion: {
      type: Sequelize.DATE,
      allowNull: true
    },
    fechaCreacion: {
      type: Sequelize.DATE,
      defaultValue: Sequelize.fn('NOW')
    }
  });
}
export async function down(queryInterface, Sequelize) {
  await queryInterface.dropTable('tareas_pendientes');
}
