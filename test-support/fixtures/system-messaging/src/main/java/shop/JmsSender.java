package shop;

import jakarta.annotation.Resource;
import jakarta.jms.Destination;
import jakarta.jms.JMSContext;

public class JmsSender {

  @Resource(lookup = "java:app/jms/Invoices")
  private Destination invoices;

  private JMSContext context;

  public void send(String payload) {
    context.createProducer().send(invoices, payload);
  }
}
