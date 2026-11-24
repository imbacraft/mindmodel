package shop;

import jakarta.ejb.ActivationConfigProperty;
import jakarta.ejb.MessageDriven;

@MessageDriven(activationConfig = {
    @ActivationConfigProperty(propertyName = "destinationType", propertyValue = "jakarta.jms.Queue"),
    @ActivationConfigProperty(propertyName = "destinationLookup", propertyValue = "java:app/jms/Orders")
})
public class CargoConsumer {
}
