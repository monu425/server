"use strict";

function registerWebHandlers(socket, deps) {
    const { eventService } = deps;

    socket.on("event:send", (request, ack) => {
        eventService.handleSend(socket, request, ack);
    });
}

module.exports = { registerWebHandlers };
