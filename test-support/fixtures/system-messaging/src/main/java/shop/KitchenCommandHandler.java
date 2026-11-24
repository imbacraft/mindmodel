package shop;

import eventuate.SagaCommandHandlersBuilder;
import eventuate.SagaCommandHandlers;

public class KitchenCommandHandler {

  public SagaCommandHandlers commandHandlers() {
    return SagaCommandHandlersBuilder
        .fromChannel(Channels.COMMAND_CHANNEL)
        .onMessage(ApproveCommand.class, this::approve)
        .build();
  }

  public void approve(ApproveCommand command) {
  }
}
