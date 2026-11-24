package shop;

import eventuate.DomainEventHandlersBuilder;
import eventuate.DomainEventHandlers;

public class EventHandlers {

  public DomainEventHandlers domainEventHandlers() {
    return DomainEventHandlersBuilder
        .forAggregateType(Channels.TICKET_EVENT_CHANNEL)
        .onEvent(Ticket.class, this::onTicket)
        .andForAggregateType("shop.Order")
        .build();
  }

  public void onTicket(DomainEventEnvelope<Ticket> envelope) {
  }
}
