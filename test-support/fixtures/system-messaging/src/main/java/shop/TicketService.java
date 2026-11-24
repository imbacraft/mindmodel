package shop;

import eventuate.AggregateDomainEventPublisher;

public class TicketService {

  private TicketDomainEventPublisher ticketPublisher;

  public void create(Ticket ticket) {
    ticketPublisher.publish(ticket, java.util.Collections.emptyList());
  }
}
