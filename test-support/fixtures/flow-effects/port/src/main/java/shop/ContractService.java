package shop;

import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

@Service
public class ContractService implements ContractPort {
    private final ContractRepo repo;
    private final RestTemplate restTemplate;

    public ContractService(ContractRepo repo, RestTemplate restTemplate) {
        this.repo = repo;
        this.restTemplate = restTemplate;
    }

    public void publish(Long voucherId) {
        repo.save(new Contract(voucherId));
        restTemplate.postForEntity("https://billing.example/contracts", voucherId, Void.class);
    }
}
